import {
  useNetInfo,
} from "@react-native-community/netinfo";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { FlashListRef } from "@shopify/flash-list";
import { fetchSpeciesCounts } from "api/observations";
import { RealmContext } from "providers/contexts";
import {
  MY_OBSERVATIONS_ACTION,
  useMyObservations,
} from "providers/MyObservationsContext";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Taxon from "realmModels/Taxon";
import type { RealmObservation } from "realmModels/types";
import type { OBSERVATIONS_SORT } from "sharedHelpers/observationsSort";
import type { SPECIES_SORT } from "sharedHelpers/speciesSort";
import {
  sortSpeciesCounts,
  speciesSortToApiParams,
} from "sharedHelpers/speciesSort";
import startupPerformanceTracker from "sharedHelpers/startupPerformanceTracker";
import {
  useCurrentUser,
  useInfiniteObservationsScroll,
  useInfiniteScroll,
  useLayoutPrefs,
  useNavigateToObsEdit,
  useObservationsUpdates,
  useStoredLayout,
} from "sharedHooks";
import useFeatureFlag from "sharedHooks/useFeatureFlag";
import useLocalObservationIds from "sharedHooks/useLocalObservationIds";
import useObservationCounts from "sharedHooks/useObservationCounts";
import { FeatureFlag } from "stores/createFeatureFlagSlice";
import type { MyObservationsSlice } from "stores/createMyObservationsSlice";
import {
  UPLOAD_PENDING,
} from "stores/createUploadObservationsSlice";
import useStore, { zustandStorage } from "stores/useStore";
import type { SpeciesCount } from "types/sorting";

import FullScreenActivityIndicator from "./FullScreenActivityIndicator";
import useMyObservationsQuery from "./hooks/useMyObservationsQuery";
import useSyncObservations from "./hooks/useSyncObservations";
import useUploadObservations from "./hooks/useUploadObservations";
import MyObservationsEmptySimple from "./MyObservationsEmptySimple";
import MyObservationsSimple, {
  OBSERVATIONS_TAB,
  TAXA_TAB,
} from "./MyObservationsSimple";

const { useRealm } = RealmContext;

export enum ACTIVE_SHEET {
  NONE = "NONE",
  LOGIN = "LOGIN",
  SORT = "SORT",
}

const MyObservationsResults = ( ) => {
  const { isDefaultMode, loggedInWhileInDefaultMode } = useLayoutPrefs();
  const realm = useRealm( );
  const navigation = useNavigation( );
  const listRef = useRef<FlashListRef<RealmObservation>>( null );
  const taxaListRef = useRef<FlashListRef<SpeciesCount>>( null );
  const navigateToObsEdit = useNavigateToObsEdit( );

  const { state: myObsState, dispatch: myObsDispatch } = useMyObservations( );

  const setStartUploadObservations = useStore( state => state.setStartUploadObservations );
  const uploadQueue = useStore( state => state.uploadQueue );
  const addToUploadQueue = useStore( state => state.addToUploadQueue );
  const addTotalToolbarIncrements = useStore( state => state.addTotalToolbarIncrements );
  const startManualSync = useStore( state => state.startManualSync );
  const startAutomaticSync = useStore( state => state.startAutomaticSync );
  const myObsOffsetToRestore = useStore( state => state.myObsOffsetToRestore );
  const setMyObsOffset = useStore( state => state.setMyObsOffset );
  const clearMyObservationsViewState: MyObservationsSlice["clearMyObservationsViewState"]
    = useStore( ( state: MyObservationsSlice ) => state.clearMyObservationsViewState );
  const uploadStatus = useStore( state => state.uploadStatus );
  const justFinishedSignup: boolean = useStore( state => state.layout.justFinishedSignup );
  // As soon as we leave this screen, the user is no longer considered as just finished signup
  const setJustFinishedSignup = useStore( state => state.layout.setJustFinishedSignup );
  useEffect( ( ) => {
    const unsubscribe = navigation.addListener( "blur", ( ) => {
      setJustFinishedSignup( false );
    } );
    return unsubscribe;
  }, [navigation, setJustFinishedSignup] );

  const localObservationIds = useLocalObservationIds();
  const sortMyObservationsEnabled = useFeatureFlag( FeatureFlag.SortMyObservationsEnabled );
  const searchMyObservationsEnabled = useFeatureFlag( FeatureFlag.SearchMyObservationsEnabled );
  const myObservationsMapViewEnabled = useFeatureFlag(
    FeatureFlag.MyObservationsMapViewEnabled,
  );
  const myObservationsSmallGridViewEnabled = useFeatureFlag(
    FeatureFlag.MyObservationsSmallGridViewEnabled,
  );
  const { isConnected } = useNetInfo( );
  const {
    observationIds: queryObservationIds,
    isServerAuthoritative,
    isLoading: isLoadingFromQuery,
    isFetchingNextPage: isFetchingNextPageFromQuery,
    fetchNextPage: fetchNextPageFromQuery,
    refetch: refetchFromQuery,
    totalResults: searchTotalResults,
  } = useMyObservationsQuery( );
  // Only use server-ordered result when at least one of the features that needs it is enabled;
  // when neither is, we use the plain local list anyway
  const myObsQueryEnabled = sortMyObservationsEnabled || searchMyObservationsEnabled;
  const useServerOrder = myObsQueryEnabled && isServerAuthoritative;
  const observationIds = myObsQueryEnabled
    ? queryObservationIds
    : localObservationIds;
  const hasActiveSearch = searchMyObservationsEnabled && !!myObsState.searchedTaxon;
  const showSearchOfflineNotice = hasActiveSearch && isConnected === false;
  const showSearchEmptyState = hasActiveSearch
    && isConnected !== false
    && !isLoadingFromQuery
    && observationIds.length === 0;
  const {
    numUnuploadedObservations,
    numObsMissingBasics,
    numUnuploadedObsNoTaxon,
  } = useObservationCounts( );
  const prevObservationsLength = useRef( observationIds.length );
  const { layout, writeLayoutToStorage } = useStoredLayout( "myObservationsLayout" );

  const currentUser = useCurrentUser( );
  const currentUserId = currentUser?.id;
  const canUpload = !!currentUser && !!isConnected;

  // If the current view mode becomes unavailable (feature flag disabled or logged out),
  // fall back to grid rather than getting stuck on an unrenderable view
  useEffect( ( ) => {
    const viewUnavailable = (
      layout === "map" && ( !myObservationsMapViewEnabled || !currentUser )
    ) || (
      layout === "smallGrid" && ( !myObservationsSmallGridViewEnabled || !currentUser )
    );
    if ( viewUnavailable ) {
      clearMyObservationsViewState( );
      writeLayoutToStorage( "grid" );
    }
  }, [
    clearMyObservationsViewState,
    layout,
    myObservationsMapViewEnabled,
    myObservationsSmallGridViewEnabled,
    currentUser,
    writeLayoutToStorage,
  ] );

  // Scroll to the top when a sync pulls in observations we've never seen locally
  const scrollToTopForNewRemoteObs = useCallback( ( ) => {
    if ( useServerOrder ) { return; }
    listRef.current?.scrollToOffset( { offset: 0, animated: true } );
    setMyObsOffset( 0 );
  }, [
    setMyObsOffset,
    useServerOrder,
  ] );

  const { startUploadObservations } = useUploadObservations( canUpload );
  const { syncManually } = useSyncObservations(
    currentUserId,
    startUploadObservations,
    scrollToTopForNewRemoteObs,
  );

  const { refetch: refetchObservationsUpdates } = useObservationsUpdates( !!currentUser );

  const {
    fetchFromLastObservation,
    fetchNextPage,
    isFetchingNextPage,
    status,
    totalResults: totalResultsRemote,
  } = useInfiniteObservationsScroll( {
    params: {
      user_id: currentUserId,
    },
  } );

  const [openSheet, setOpenSheet] = useState<ACTIVE_SHEET>( ACTIVE_SHEET.NONE );

  const setSpeciesSortOptionId = ( value: SPECIES_SORT ) => {
    myObsDispatch( {
      type: MY_OBSERVATIONS_ACTION.SET_SPECIES_SORT,
      speciesSort: value,
    } );
  };

  const setObservationsSortOptionId = ( value: OBSERVATIONS_SORT ) => {
    myObsDispatch( {
      type: MY_OBSERVATIONS_ACTION.SET_OBSERVATIONS_SORT,
      observationsSort: value,
    } );
  };

  const updateObservationsView = ( value: string ) => {
    // Map position and closed/expanded taxa categories belong to the view the user was in.
    // Returning to MyObs from elsewhere in the app should restore the view you left, but
    // switching views should reset the view to its default state.
    if ( value !== layout ) {
      clearMyObservationsViewState( );
    }
    writeLayoutToStorage( value );
  };

  const confirmInternetConnection = useCallback( ( ) => isConnected, [isConnected] );

  const confirmLoggedIn = useCallback( ( ) => {
    if ( !currentUser ) {
      setOpenSheet( ACTIVE_SHEET.LOGIN );
    }
    return currentUser;
  }, [currentUser] );

  const handleSyncButtonPress = useCallback( ( ) => {
    if ( !confirmLoggedIn( ) ) { return; }
    if ( !confirmInternetConnection( ) ) { return; }

    startManualSync( );
    syncManually( {} );
  }, [
    confirmLoggedIn,
    confirmInternetConnection,
    startManualSync,
    syncManually,
  ] );

  const handleIndividualUploadPress = useCallback( uuid => {
    const uploadExists = uploadQueue.includes( uuid );
    if ( uploadExists ) return;
    const observation = realm.objectForPrimaryKey<RealmObservation>( "Observation", uuid );
    if ( isDefaultMode && observation.missingBasics( ) ) {
      navigateToObsEdit( observation );
      return;
    }
    if ( !confirmLoggedIn( ) ) return;
    if ( !confirmInternetConnection( ) ) return;
    addTotalToolbarIncrements( observation );
    addToUploadQueue( uuid );
    if ( uploadStatus === UPLOAD_PENDING ) {
      setStartUploadObservations( );
    }
  }, [
    addTotalToolbarIncrements,
    addToUploadQueue,
    confirmInternetConnection,
    confirmLoggedIn,
    isDefaultMode,
    navigateToObsEdit,
    realm,
    setStartUploadObservations,
    uploadQueue,
    uploadStatus,
  ] );

  // 20241107 amanda - this seems to be a culprit for the tab bar being less
  // tappable sometimes, because automatic sync is still in progress and gets restarted
  // if a user toggles between tabs too quickly. using the isActive boolean should help
  useFocusEffect(
    // need to reset the state on a FocusEffect, not a blur listener, because
    // tab bar screens don't seem to blur
    useCallback( ( ) => {
      let isActive = true;
      let idleCallbackId = 0;
      if ( isActive ) {
        idleCallbackId = requestIdleCallback( ( ) => {
          startupPerformanceTracker.emitStartupTTI( {
            targetScreen: "MyObservations",
            loggedIn: !!currentUser,
          } );
        } );
        startAutomaticSync( );
      }
      return () => {
        isActive = false;
        if ( idleCallbackId ) { cancelIdleCallback( idleCallbackId ); }
      };
    }, [currentUser, startAutomaticSync] ),
  );

  const handlePullToRefresh = useCallback( async ( ) => {
    await syncManually( { skipUploads: true } );
    refetchObservationsUpdates( );
    if ( useServerOrder ) {
      refetchFromQuery( );
    }
  }, [syncManually, refetchObservationsUpdates, useServerOrder, refetchFromQuery] );

  // Scroll the list to the offset we need to restore, e.g. when you are
  // scrolled way down, edit an observation, and return. Entering ObsEdit
  // takes you into a parallel stack navigator, which will destroy MyObs, so
  // we need to keep track of the scroll offset manually
  const restoreScrollOffset = useCallback( ( ) => {
    if ( listRef.current && myObsOffsetToRestore ) {
      listRef.current.scrollToOffset( { offset: myObsOffsetToRestore } );
    }
  }, [
    myObsOffsetToRestore,
  ] );

  // Scroll to the top whenever the active taxon search changes
  useEffect( ( ) => {
    if ( listRef.current ) {
      listRef.current.scrollToOffset( { offset: 0, animated: true } );
    }
  }, [myObsState.searchedTaxon?.id] );

  // API call fetching obs has completed but results are not yet stored in realm
  // for display here
  const showLoading = ( totalResultsRemote || 0 ) > 0 && observationIds.length === 0;

  // show empty screen instead of loading wheel...
  const showNoResults = !showLoading && (
    // ...if the user is not signed in, or...
    !currentUser
    // ...if the signed in user is offline and has no observations, or...
    || ( !isConnected && observationIds.length === 0 )
    // ...if signed in, online user requested their own obs for the first time
    //    and has 0 obs
    || status !== "pending"
  );

  // Keep track of the scroll offset so we can restore it when we mount
  // this component again after returning from ObsEdit
  const onScroll = ( scrollEvent: {
    nativeEvent: {
      contentOffset: {
        y: number;
      };
    };
  } ) => setMyObsOffset( scrollEvent.nativeEvent.contentOffset.y );

  const numOfUserObservations = zustandStorage.getItem( "numOfUserObservations" );
  const numOfUserSpecies = zustandStorage.getItem( "numOfUserSpecies" );
  const [activeTab, setActiveTab] = useState( OBSERVATIONS_TAB );

  const { leafTaxonIds, numTotalTaxaLocal } = useMemo<{
    leafTaxonIds: number[];
    numTotalTaxaLocal: number | undefined;
  }>( () => {
    if ( currentUser ) {
      return { leafTaxonIds: [], numTotalTaxaLocal: undefined };
    }

    // Calculate obs and leaf taxa counts from local observations
    const distinctTaxonObs = realm.objects<RealmObservation>( "Observation" )
      .filtered( "taxon != null DISTINCT(taxon.id)" );
    const taxonIds: number[] = distinctTaxonObs
      .map( o => o.taxon?.id || 0 )
      .filter( Boolean );
    // A Set, not an array: the leaf filter below asks "is this id an ancestor
    // of anything?" once per distinct taxon, and Array.includes answers that by
    // scanning. A library with a few hundred taxa has tens of thousands of
    // ancestor ids between them, so the pair was quadratic and ran on the JS
    // thread — this screen carries the app log's worst freeze, a 31s ui_hang.
    const ancestorIds = new Set<number>( );
    distinctTaxonObs.forEach( o => {
      // We're filtering b/c for taxa above species level, the taxon's own
      // ID is included in ancestor ids for some reason (this is a bug...
      // somewhere)
      ( o.taxon?.ancestor_ids || [] ).forEach( id => {
        if ( Number( id ) !== Number( o.taxon?.id ) ) { ancestorIds.add( Number( id ) ); }
      } );
    } );
    const leafTaxonIds = taxonIds.filter( taxonId => !ancestorIds.has( Number( taxonId ) ) );

    return {
      leafTaxonIds,
      numTotalTaxaLocal: leafTaxonIds.length,
    };
  }, [currentUser, realm] );

  const localObservedSpeciesCount = useMemo( () => {
    if ( currentUser || activeTab !== TAXA_TAB || !leafTaxonIds.length ) {
      return [];
    }

    const localObs = realm.objects<RealmObservation>( "Observation" )
      .filtered( "taxon.id IN $0", leafTaxonIds );

    // One pass over the observations, not one pass per taxon. This used to
    // re-scan the whole collection for every leaf taxon, and each scan reads
    // every object's taxon across the Realm boundary, so the cost was
    // observations × taxa: a library with 1,400 observations and 500 leaf taxa
    // meant 700,000 property reads in one synchronous go.
    const countsByTaxonId = new Map<number, { count: number; taxon: RealmObservation["taxon"] }>( );
    localObs.forEach( o => {
      const id = o.taxon?.id;
      if ( id === undefined || id === null ) return;
      const existing = countsByTaxonId.get( id );
      if ( existing ) {
        existing.count += 1;
      } else {
        countsByTaxonId.set( id, { count: 1, taxon: o.taxon } );
      }
    } );

    // Preserve the previous shape and ordering: one entry per leaf taxon, in
    // leafTaxonIds order. A taxon the query returned nothing for used to throw
    // on obs[0].taxon, so dropping it is not a behaviour change.
    return leafTaxonIds
      .map( id => countsByTaxonId.get( id ) )
      .filter( ( entry ): entry is NonNullable<typeof entry> => !!entry );
  }, [currentUser, activeTab, realm, leafTaxonIds] );

  // Map the selected sort option to API params
  const sortAPIParams = useMemo(
    () => speciesSortToApiParams( myObsState.speciesSort ),
    [myObsState.speciesSort],
  );

  const {
    data: remoteObservedTaxaCounts,
    isFetching: isLoadingTaxa,
    isFetchingNextPage: isFetchingTaxa,
    fetchNextPage: fetchMoreTaxa,
    totalResults: numTotalTaxaRemote,
    refetch: refetchTaxa,
  } = useInfiniteScroll(
    `MyObsSimple-fetchSpeciesCounts-${currentUser?.id}-${myObsState.speciesSort}`,
    fetchSpeciesCounts,
    {
      user_id: currentUser?.id,
      ...sortAPIParams,
      ...( myObsState.searchedTaxon?.id
        ? { taxon_id: myObsState.searchedTaxon.id }
        : {} ),
      fields: {
        taxon: Taxon.LIMITED_TAXON_FIELDS,
      },
    },
    {
      enabled: !!currentUser,
    },
  );

  const numTotalTaxa = typeof ( numTotalTaxaRemote ) === "number"
    ? numTotalTaxaRemote
    : numTotalTaxaLocal;

  const numTotalObservations = totalResultsRemote || observationIds.length;

  // When a search is active, we want to show a live, search-informed total for observation and
  // species counts, otherwise, fallback to the values from zustand
  const displayedObservationsCount = hasActiveSearch
    ? searchTotalResults
    : numOfUserObservations;

  const displayedSpeciesCount = hasActiveSearch
    ? numTotalTaxa
    : numOfUserSpecies;

  // Pagination for the rendered list follows whichever source is authoritative:
  const isFetchingNextPageForList = useServerOrder
    ? isFetchingNextPageFromQuery
    : isFetchingNextPage;
  const handleEndReached = useServerOrder
    ? fetchNextPageFromQuery
    : fetchNextPage;

  useEffect( ( ) => {
    // persist this number in zustand so a user can see their latest observations count
    // even if they're offline
    if ( numTotalObservations > numOfUserObservations ) {
      zustandStorage.setItem( "numOfUserObservations", numTotalObservations );
    }
  }, [numTotalObservations, numOfUserObservations] );

  useEffect( ( ) => {
    // persist this number in zustand so a user can see their latest species count
    // even if they're offline
    if ( numTotalTaxa > numOfUserSpecies ) {
      zustandStorage.setItem( "numOfUserSpecies", numTotalTaxa );
    }
  }, [numTotalTaxa, numOfUserSpecies] );

  useEffect( () => {
    const newObservationCount = observationIds.length - prevObservationsLength.current;

    if ( newObservationCount > 0 && listRef?.current ) {
      if ( listRef.current.notifyDataFetched ) {
        listRef.current.notifyDataFetched( newObservationCount );
      } else {
        console.warn( "notifyDataFetched method not found on listRef" );
      }
    }

    prevObservationsLength.current = observationIds.length;
  }, [observationIds.length, listRef] );

  const taxa = useMemo( () => {
    const unsortedTaxa = currentUser
      ? remoteObservedTaxaCounts
      : localObservedSpeciesCount;

    // For logged-in users: we get data sorted from the API
    if ( currentUser && isConnected ) {
      return unsortedTaxa || [];
    }

    // For logged-out users: apply client-side sorting to local data
    return sortSpeciesCounts( unsortedTaxa || [], myObsState.speciesSort );
  }, [
    currentUser,
    isConnected,
    remoteObservedTaxaCounts,
    localObservedSpeciesCount,
    myObsState.speciesSort,
  ] );

  const showSpeciesSearchEmptyState = hasActiveSearch
    && isConnected !== false
    && !isLoadingTaxa
    && taxa.length === 0;

  if ( !layout ) { return null; }

  if ( observationIds.length === 0 && !totalResultsRemote ) {
    return showNoResults
      ? (
        <MyObservationsEmptySimple
          currentUser={currentUser}
          isConnected={isConnected}
          justFinishedSignup={justFinishedSignup}
        />
      )
      : (
        <FullScreenActivityIndicator />
      );
  }

  return (
    <MyObservationsSimple
      activeTab={activeTab}
      currentUser={currentUser}
      fetchMoreTaxa={fetchMoreTaxa}
      fetchFromLastObservation={fetchFromLastObservation}
      handleIndividualUploadPress={handleIndividualUploadPress}
      handlePullToRefresh={handlePullToRefresh}
      handleSyncButtonPress={handleSyncButtonPress}
      isConnected={isConnected}
      isFetchingNextPage={isFetchingNextPageForList}
      isFetchingTaxa={isFetchingTaxa}
      justFinishedSignup={justFinishedSignup}
      layout={layout}
      listRef={listRef}
      loggedInWhileInDefaultMode={loggedInWhileInDefaultMode}
      taxaListRef={taxaListRef}
      numTotalObservations={displayedObservationsCount}
      numTotalTaxa={displayedSpeciesCount}
      numUnuploadedObservations={numUnuploadedObservations}
      numObsMissingBasics={numObsMissingBasics}
      numUnuploadedObsNoTaxon={numUnuploadedObsNoTaxon}
      observationIds={observationIds}
      observationsSortOptionId={myObsState.observationsSort}
      onEndReached={handleEndReached}
      onListLayout={restoreScrollOffset}
      onScroll={onScroll}
      openSheet={openSheet}
      refetchTaxa={refetchTaxa}
      setActiveTab={setActiveTab}
      setObservationsSortOptionId={setObservationsSortOptionId}
      setOpenSheet={setOpenSheet}
      setSpeciesSortOptionId={setSpeciesSortOptionId}
      showNoResults={showNoResults}
      showSearchEmptyState={showSearchEmptyState}
      showSearchOfflineNotice={showSearchOfflineNotice}
      showSpeciesSearchEmptyState={showSpeciesSearchEmptyState}
      speciesSortOptionId={myObsState.speciesSort}
      taxa={taxa}
      updateObservationsView={updateObservationsView}
    />
  );
};

export default MyObservationsResults;
