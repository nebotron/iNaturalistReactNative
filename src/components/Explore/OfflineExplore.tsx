import type { ApiObservation } from "api/types";
import ObservationsFlashList from "components/ObservationsFlashList/ObservationsFlashList";
import {
  Body3,
  Button,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, {
  useEffect, useMemo, useState, useSyncExternalStore,
} from "react";
import { Alert } from "react-native";
import {
  deleteOfflineExploreResults,
  downloadOfflineExploreResults,
  getOfflineExploreRealm,
  getOfflineExploreVersion,
  MAX_OFFLINE_OBSERVATIONS,
  openOfflineExploreRealm,
  queryOfflineObservations,
  subscribeOfflineExploreResults,
} from "sharedHelpers/offlineExploreResults";
import { useTranslation } from "sharedHooks";
import { getShadow } from "styles/global";

const DROP_SHADOW = getShadow( { offsetHeight: 4, elevation: 6 } );
const OBS_LIST_CONTAINER_STYLE = { paddingTop: 50 };
const PAGE_SIZE = 100;
const noop = ( ) => undefined;

type Params = Record<string, unknown>;

// Saved results matching params, re-queried whenever the saved results change
export const useOfflineExploreResults = ( params: Params ) => {
  useEffect( ( ) => { openOfflineExploreRealm( ); }, [] );
  const version = useSyncExternalStore(
    subscribeOfflineExploreResults,
    getOfflineExploreVersion,
  );
  return useMemo( ( ) => {
    const db = getOfflineExploreRealm( );
    if ( !db ) return null;
    const total = db.objects( "OfflineExploreObservation" ).length;
    if ( total === 0 ) return null;
    return { total, results: queryOfflineObservations( db, params ) };
  // version changes whenever the saved results do
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, version] );
};

interface SaveProps {
  // Resolves the current search's API params when saving
  getQueryParams: ( ) => Promise<Params>;
  disabled?: boolean;
}

// Adds the current search's results to the ones saved for offline use
export const SaveOfflineButton = ( { getQueryParams, disabled }: SaveProps ) => {
  const { t } = useTranslation( );
  const [progress, setProgress] = useState<number | null>( null );

  const save = async ( ) => {
    setProgress( 0 );
    try {
      const { added, total } = await downloadOfflineExploreResults(
        await getQueryParams( ),
        setProgress,
      );
      Alert.alert( t( "Added-X-offline-observations", { count: added, total } ) );
    } catch {
      Alert.alert( t( "Something-went-wrong" ) );
    } finally {
      setProgress( null );
    }
  };

  const onPress = ( ) => Alert.alert(
    t( "Save-for-offline-use" ),
    t( "Add-up-to-observations-from-this-search", { count: MAX_OFFLINE_OBSERVATIONS } ),
    [
      { text: t( "Cancel" ), style: "cancel" },
      { text: t( "SAVE" ), onPress: save },
    ],
  );

  return (
    <View className="px-4 mb-7">
      <Button
        text={progress === null
          ? t( "SAVE-RESULTS-FOR-OFFLINE-USE" )
          : t( "Saving-X-observations", { count: progress } )}
        disabled={disabled || progress !== null}
        loading={progress !== null}
        onPress={onPress}
        accessibilityLabel={t( "Save-for-offline-use" )}
        testID="SaveOfflineButton"
      />
    </View>
  );
};

interface ViewProps {
  layout: string | null;
  queryParams: Params;
}

// Shows saved results, filtered on device by the current Explore filters
export const OfflineObservationsView = ( { layout, queryParams }: ViewProps ) => {
  const { t } = useTranslation( );
  const saved = useOfflineExploreResults( queryParams );
  // Paging restarts when the filters change
  const [paging, setPaging] = useState( { params: queryParams, limit: PAGE_SIZE } );
  const limit = paging.params === queryParams
    ? paging.limit
    : PAGE_SIZE;
  // Parse only the rows the list has scrolled to
  const observations = useMemo(
    ( ) => ( saved?.results.slice( 0, limit ) || [] )
      .map( row => JSON.parse( row.json ) as ApiObservation ),
    [saved, limit],
  );
  if ( !saved ) return null;
  const listLayout = layout === "list"
    ? "list"
    : "grid";
  const onPressDelete = ( ) => Alert.alert( t( "Delete-offline-results" ), undefined, [
    { text: t( "Cancel" ), style: "cancel" },
    { text: t( "DELETE" ), style: "destructive", onPress: deleteOfflineExploreResults },
  ] );

  return (
    <View className="flex-1">
      <ObservationsFlashList
        contentContainerStyle={OBS_LIST_CONTAINER_STYLE}
        data={observations}
        explore
        handlePullToRefresh={noop}
        handleIndividualUploadPress={noop}
        hideLoadingWheel
        isConnected={false}
        layout={listLayout}
        obsListKey="OfflineExploreObservations"
        onEndReached={( ) => setPaging( { params: queryParams, limit: limit + PAGE_SIZE } )}
        showNoResults={saved.results.length === 0}
        hideObsUploadStatus={listLayout === "grid"}
        fullWidthGrid={listLayout === "grid"}
        testID="OfflineExploreObservations"
      />
      <View
        className="absolute bottom-5 right-5 z-10 bg-white rounded-full px-3 py-2"
        style={DROP_SHADOW}
      >
        <Body3 onPress={onPressDelete}>
          {t( "Offline-X-of-Y-saved-observations", {
            count: saved.results.length,
            total: saved.total,
          } )}
        </Body3>
      </View>
    </View>
  );
};
