import { getJWT } from "components/LoginSignUp/AuthenticationService";
import type { ObservationsFilter } from "components/MyObservations/helpers/fetchAllObservations";
import {
  CONFIRM_FETCH_ALL_OVER,
  countLocalObservations,
  countRemoteObservations,
  fetchAllObservations,
  observationsFilterKey,
} from "components/MyObservations/helpers/fetchAllObservations";
import { RealmContext } from "providers/contexts";
import { useCallback } from "react";
import { Alert } from "react-native";
import { log } from "sharedHelpers/logger";
import { OBSERVATIONS_SORT } from "sharedHelpers/observationsSort";
import { useCurrentUser, useTranslation } from "sharedHooks";
import useStore from "stores/useStore";

const { useRealm } = RealmContext;

const logger = log.extend( "useTaxonomicSortFetch" );

// Taxonomic order can only sort what's on the device, so before using it this makes sure every
// observation the current search matches has been downloaded, asking first when there are a lot.
// The download outlives the screen, and stops when the sort or search changes.
const useTaxonomicSortFetch = ( ) => {
  const realm = useRealm( );
  const currentUser = useCurrentUser( );
  const { t } = useTranslation( );
  const userId = currentUser?.id;

  const confirmFetchAll = useCallback( ( count: number ) => new Promise<boolean>( resolve => {
    Alert.alert(
      t( "Load-all-count-observations", { count } ),
      t( "Taxonomic-order-downloads-all-observations-which-may-take-a-while" ),
      [
        { text: t( "No" ), style: "cancel", onPress: ( ) => resolve( false ) },
        { text: t( "Yes" ), onPress: ( ) => resolve( true ) },
      ],
      { cancelable: true, onDismiss: ( ) => resolve( false ) },
    );
  } ), [t] );

  const startFetch = useCallback( ( filter: ObservationsFilter, total: number ) => {
    const filterKey = observationsFilterKey( filter );
    const { setTaxonomicFetch } = useStore.getState( );
    setTaxonomicFetch( { filterKey, fetched: 0, total } );
    // Still wanted: the sort hasn't changed and no download for another search replaced this one
    const isCurrent = ( ) => {
      const state = useStore.getState( );
      return state.taxonomicFetch?.filterKey === filterKey
        && state.myObservations.observationsSort === OBSERVATIONS_SORT.TAXONOMY;
    };
    const finish = ( ) => {
      if ( useStore.getState( ).taxonomicFetch?.filterKey === filterKey ) {
        setTaxonomicFetch( null );
      }
    };
    fetchAllObservations( realm, filter, getJWT, ( fetched, remoteTotal ) => {
      if ( !isCurrent( ) ) return false;
      setTaxonomicFetch( { filterKey, fetched, total: remoteTotal } );
      return true;
    } )
      .catch( error => {
        logger.error( "Failed to download observations for taxonomic order", error );
      } )
      .finally( finish );
  }, [realm] );

  // Resolves false if the user chose not to download everything. Otherwise any download it
  // needs has started, and the caller can apply the sort
  const prepareTaxonomicSort = useCallback( async ( taxonId?: number ): Promise<boolean> => {
    if ( !userId ) return true;
    const filter = { userId, taxonId };
    useStore.getState( ).setTaxonomicFetchCheckedFilterKey( observationsFilterKey( filter ) );
    let total: number;
    try {
      total = await countRemoteObservations( filter, await getJWT( ) );
    } catch ( error ) {
      // Sort what's already here rather than block the sort
      logger.error( "Failed to count observations for taxonomic order", error );
      return true;
    }
    if ( countLocalObservations( realm, filter ) >= total ) return true;
    if ( total > CONFIRM_FETCH_ALL_OVER && !( await confirmFetchAll( total ) ) ) return false;
    startFetch( filter, total );
    return true;
  }, [confirmFetchAll, realm, startFetch, userId] );

  return { prepareTaxonomicSort };
};

export default useTaxonomicSortFetch;
