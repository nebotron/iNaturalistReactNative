import { refresh, useNetInfo } from "@react-native-community/netinfo";
import { useFocusEffect, useRoute } from "@react-navigation/native";
import { useQueryClient } from "@tanstack/react-query";
import type { ApiTotalBounds } from "api/types";
import {
  HOTSPOTS_TAB,
  IDENTIFICATIONS_TAB,
  IDENTIFIERS_TAB,
  IDENTIFY_TAB,
  LIFELIST_TAB,
  OBSERVATIONS_TAB,
  OBSERVERS_TAB,
  SPECIES_TAB,
} from "appConstants/tabs";
import ExcludedSpeciesError
  from "components/Explore/components/ExcludedSpeciesError";
import ExploreConnectionBanner
  from "components/Explore/components/ExploreConnectionBanner";
import ExploreHeader
  from "components/Explore/components/ExploreHeader";
import ExploreMapView
  from "components/Explore/components/ExploreMapView";
import GridOverlaysSheet
  from "components/Explore/components/GridOverlaysSheet";
import TaxonomicOrderNotice
  from "components/Explore/components/TaxonomicOrderNotice";
import type { NearbyCoords }
  from "components/Explore/helpers/buildQueryParams";
import buildExploreQueryParams
  from "components/Explore/helpers/buildQueryParams";
import useExcludedSpecies
  from "components/Explore/hooks/useExcludedSpecies";
import { useExploreLayoutKey } from "components/Explore/hooks/useExploreDisplaySettings";
import useInfiniteExploreScroll
  from "components/Explore/hooks/useInfiniteExploreScroll";
import IdentifyView from "components/Explore/IdentifyView";
import LifeListView from "components/Explore/LifeListView";
import ObservationsViewBar from "components/Explore/ObservationsViewBar";
import ExploreIdentificationsView
  from "components/Explore/screens/ExploreIdentificationsView";
import ExploreSpeciesView
  from "components/Explore/screens/ExploreSpeciesView";
import ExploreUsersView
  from "components/Explore/screens/ExploreUsersView";
import CombineObservationsBar from "components/MyObservations/CombineObservationsBar";
import ObservationsFlashList from "components/ObservationsFlashList/ObservationsFlashList";
import {
  ActivityIndicator,
  Body2,
  Button,
  OfflineNotice,
  RadioButtonSheet,
  ViewWrapper,
} from "components/SharedComponents";
import INatIconButton from "components/SharedComponents/Buttons/INatIconButton";
import SortButton from "components/SharedComponents/Buttons/SortButton";
import { View } from "components/styledComponents";
import WildlifeHotspotsScreen from "components/WildlifeHotspots/WildlifeHotspotsScreen";
import type { ExploreStackScreenProps } from "navigation/types";
import type { ExploreTab } from "providers/ExploreContext";
import { EXPLORE_ACTION, EXPLORE_PLACE_MODE, useExplore } from "providers/ExploreContext";
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { log } from "sharedHelpers/logger";
import { setMemoryContext } from "sharedHelpers/memoryWatermark";
import {
  EXPLORE_OBSERVATIONS_SORT_OPTIONS,
  OBSERVATIONS_SORT,
  useObservationsSortLabels,
} from "sharedHelpers/observationsSort";
import type { SpeciesCountsSort } from "sharedHelpers/speciesSort";
import {
  EXPLORE_SPECIES_SORT_OPTIONS,
  SPECIES_SORT,
  speciesSortToSpeciesCountsParams,
  useSpeciesSortLabels,
} from "sharedHelpers/speciesSort";
import {
  EXPLORE_TAXONOMIC_OBSERVATIONS_LIMIT,
  sortByTaxonomy,
} from "sharedHelpers/taxonomicSort";
import { useTranslation } from "sharedHooks";
import useCurrentUser from "sharedHooks/useCurrentUser";
import useFetchPagesUpTo from "sharedHooks/useFetchPagesUpTo";
import useLocationPermission from "sharedHooks/useLocationPermission";
import useSpeciesCount from "sharedHooks/useSpeciesCount";
import useStoredLayout from "sharedHooks/useStoredLayout";
import useSubjectDistances, { sortBySubjectDistance } from "sharedHooks/useSubjectDistances";
import { useLineages } from "sharedHooks/useTaxonomicLineages";
import type { HotspotSettings } from "stores/createLayoutSlice";
import { DEFAULT_HOTSPOT_SETTINGS } from "stores/createLayoutSlice";
import useStore from "stores/useStore";
import { getShadow } from "styles/global";

// Please don't change this to an aliased path or the e2e mock will not get
// used in our e2e tests on Github Actions
import fetchCoarseUserLocation from "../../../sharedHelpers/fetchCoarseUserLocation";
import {
  getLatestTrackedLocation,
} from "../../../sharedHelpers/locationHistoryTracker";

const SPECIES_COUNT_KEY = "exploreSpeciesCount";

// The most observations the API returns in a page
const TAXONOMIC_PER_PAGE = 200;

interface SortOption<SortValue> {
  label: string;
  text: string;
  value: SortValue;
}

const EXPLORE_VIEW_ICONS: Record<ExploreTab, string> = {
  [OBSERVATIONS_TAB]: "binoculars",
  [IDENTIFY_TAB]: "id-agree",
  [SPECIES_TAB]: "leaf",
  [HOTSPOTS_TAB]: "location",
  [OBSERVERS_TAB]: "observers",
  [IDENTIFIERS_TAB]: "identifiers",
  [LIFELIST_TAB]: "list",
  [IDENTIFICATIONS_TAB]: "id-agree",
};

const noop = ( ) => undefined;

const logger = log.extend( "ExploreResults" );

// How long the observations tab may sit empty after a view switch before we log it
const EMPTY_AFTER_SWITCH_MS = 8000;

const DROP_SHADOW = getShadow( {
  offsetHeight: 4,
  elevation: 6,
} );

const ExploreResults = ( ) => {
  const { dispatch, state } = useExplore( );
  const { params } = useRoute<ExploreStackScreenProps<"ExploreResults">["route"]>( );
  // The Explore tab itself, rather than an Explore opened from somewhere else. Only the tab
  // is put back as the user left it when they return to it.
  const isRootExplore = !params?.showBackButton;
  const currentUser = useCurrentUser( );
  const currentUserId = currentUser?.id;
  const {
    hasPermissions,
    hasBlockedPermissions,
    renderPermissionsGate,
    requestPermissions,
  } = useLocationPermission( );
  const { isConnected } = useNetInfo( );
  const { t } = useTranslation( );
  const [showSortSheet, setShowSortSheet] = useState( false );
  const [showViewSheet, setShowViewSheet] = useState( false );
  const [showGridOverlaysSheet, setShowGridOverlaysSheet] = useState( false );
  const [lifeListCount, setLifeListCount] = useState<number | null>( null );
  const handleLifeListCount = useCallback(
    ( _view: string, count: number ) => setLifeListCount( count ),
    [],
  );
  const [identificationsCount, setIdentificationsCount] = useState<number | null>( null );
  const [observersCount, setObserversCount] = useState<number | null>( null );
  const observationsSortLabels = useObservationsSortLabels( );
  const speciesSortLabels = useSpeciesSortLabels( );
  const { layout, writeLayoutToStorage } = useStoredLayout( useExploreLayoutKey( ) );

  const showMap = layout === "map";

  const sortOptions = EXPLORE_OBSERVATIONS_SORT_OPTIONS.reduce(
    ( acc, sortBy ) => {
      const { label, text } = observationsSortLabels[sortBy];
      acc[sortBy] = {
        label,
        text,
        value: sortBy,
      };
      return acc;
    },
    {} as Record<OBSERVATIONS_SORT, SortOption<OBSERVATIONS_SORT>>,
  );

  const speciesSortOptions = EXPLORE_SPECIES_SORT_OPTIONS.reduce(
    ( acc, sortBy ) => {
      const { label, text } = speciesSortLabels[sortBy];
      acc[sortBy] = {
        label,
        text,
        value: sortBy,
      };
      return acc;
    },
    {} as Record<SpeciesCountsSort, SortOption<SpeciesCountsSort>>,
  );

  const isNearby = state.location.placeMode === EXPLORE_PLACE_MODE.NEARBY;
  // Kept for the session, so coming back to the tab shows the same nearby results
  // and map rather than re-resolving the location
  const setExploreNearbyCoords = useStore( s => s.setExploreNearbyCoords );
  const [nearbyCoords, setNearbyCoordsState] = useState<NearbyCoords | undefined>(
    ( ) => ( isRootExplore
      ? useStore.getState( ).exploreNearbyCoords ?? undefined
      : undefined ),
  );
  const setNearbyCoords = useCallback( ( coords: NearbyCoords ) => {
    setNearbyCoordsState( coords );
    if ( isRootExplore ) setExploreNearbyCoords( coords );
  }, [isRootExplore, setExploreNearbyCoords] );
  // Applying a saved search re-resolves Nearby against the latest location
  const { appliedSearchCount } = state;
  const coordsSearchCountRef = useRef( appliedSearchCount );

  useFocusEffect( useCallback( ( ) => {
    let cancelled = false;
    const coordsStale = nearbyCoords === undefined
      || coordsSearchCountRef.current !== appliedSearchCount;
    if ( isNearby && hasBlockedPermissions ) {
      // perms blocked: fall back to worldwide
      dispatch( { type: EXPLORE_ACTION.SET_LOCATION_WORLDWIDE } );
    } else if ( isNearby && hasPermissions === true && coordsStale ) {
      getLatestTrackedLocation( ).then(
        tracked => tracked ?? fetchCoarseUserLocation( ),
      ).then( location => {
        if ( cancelled ) return;
        if ( typeof location?.latitude === "number" ) {
          coordsSearchCountRef.current = appliedSearchCount;
          setNearbyCoords( { lat: location.latitude, lng: location.longitude } );
        } else {
          // Perms granted but no fix — fall back to worldwide.
          dispatch( { type: EXPLORE_ACTION.SET_LOCATION_WORLDWIDE } );
        }
      } );
    }
    return ( ) => { cancelled = true; };
  }, [
    isNearby,
    hasPermissions,
    hasBlockedPermissions,
    nearbyCoords,
    appliedSearchCount,
    dispatch,
    setNearbyCoords,
  ] ) );

  const handleRedoSearchPress = useCallback(
    ( bounds: ApiTotalBounds ) => dispatch( {
      type: EXPLORE_ACTION.SET_LOCATION_MAP_AREA,
      bounds,
    } ),
    [dispatch],
  );

  const needsPermission = isNearby && hasPermissions === false && !hasBlockedPermissions;
  const nearbyResolved = !isNearby || nearbyCoords !== undefined;
  // Excluded species ("Unobserved by me", or those in a saved search) can't be
  // applied until they're resolved, and nothing is fetched until then
  const excludedSpecies = useExcludedSpecies( state, {
    searchCount: appliedSearchCount,
    offline: isConnected === false,
    nearbyCoords,
    currentUserId,
    enabled: nearbyResolved,
  } );
  const excludedSpeciesIds = excludedSpecies.ids;
  const excludedSpeciesReady = !excludedSpecies.active || !!excludedSpeciesIds;
  const canFetch = !needsPermission && nearbyResolved && excludedSpeciesReady;

  const queryParams = useMemo(
    ( ) => buildExploreQueryParams(
      state,
      nearbyCoords,
      currentUserId,
      excludedSpeciesIds,
    ),
    [state, nearbyCoords, currentUserId, excludedSpeciesIds],
  );

  // Taxonomic order is sorted on device, so it loads its results in bigger pages up front
  const byTaxonomy = state.sortBy === OBSERVATIONS_SORT.TAXONOMY;
  const observationsParams = useMemo( ( ) => ( byTaxonomy
    ? { ...queryParams, per_page: TAXONOMIC_PER_PAGE }
    : queryParams ), [byTaxonomy, queryParams] );

  const {
    error: observationsError,
    fetchNextPage,
    fetchStatus: observationsFetchStatus,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    handlePullToRefresh,
    observations,
    status: observationsStatus,
    totalBounds,
    totalResults,
    isPlaceholderData,
    dataUpdatedAt,
    refreshFailed,
  } = useInfiniteExploreScroll( {
    params: observationsParams,
    // Only the observations view uses this search
    enabled: canFetch && state.activeTab === OBSERVATIONS_TAB,
    // The last results stay up, dimmed, rather than none, while a new search loads
    keepPreviousResults: true,
  } );

  const sortsTaxonomically = byTaxonomy && state.activeTab === OBSERVATIONS_TAB && !showMap;
  useFetchPagesUpTo( {
    enabled: sortsTaxonomically && canFetch,
    loadedCount: observations.length,
    limit: EXPLORE_TAXONOMIC_OBSERVATIONS_LIMIT,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } );
  const taxonomicLoadDone = !hasNextPage
    || observations.length >= EXPLORE_TAXONOMIC_OBSERVATIONS_LIMIT;
  const observationTaxa = useMemo( ( ) => {
    if ( !sortsTaxonomically ) return [];
    return observations.flatMap( ( { uuid, taxon } ) => ( taxon?.id
      ? [{ key: uuid, taxon: { ...taxon, id: taxon.id } }]
      : [] ) );
  }, [sortsTaxonomically, observations] );
  const observationLineages = useLineages(
    observationTaxa,
    sortsTaxonomically,
    taxonomicLoadDone,
  );

  // Only the user's own local photos have a subject distance, so loaded results are
  // sorted on device and everyone else's come last
  const bySubjectDistance = state.sortBy === OBSERVATIONS_SORT.SUBJECT_DISTANCE_NEAREST;
  const subjectDistances = useSubjectDistances( bySubjectDistance );
  const sortedObservations = useMemo( ( ) => {
    if ( bySubjectDistance ) return sortBySubjectDistance( observations, subjectDistances );
    if ( sortsTaxonomically ) {
      return sortByTaxonomy(
        observations.slice( 0, EXPLORE_TAXONOMIC_OBSERVATIONS_LIMIT ),
        observationLineages,
      );
    }
    return observations;
  }, [
    bySubjectDistance,
    observations,
    subjectDistances,
    sortsTaxonomically,
    observationLineages,
  ] );

  // What Explore shows, for the memory log: the Nov 25 kill climbed ~1 GB at a
  // time while it was open, and the map and the grid hold very different things
  useEffect( ( ) => {
    setMemoryContext( "explore", {
      tab: state.activeTab,
      layout,
      results: sortedObservations.length,
    } );
  }, [state.activeTab, layout, sortedObservations.length] );
  useEffect( ( ) => ( ) => setMemoryContext( "explore" ), [] );

  // Diagnostics: observations sometimes show nothing after switching from
  // another view (e.g. Hotspots) or opening a hotspot in Explore, until a reload
  const diagnosticsRef = useRef<Record<string, unknown>>( {} );
  const errorStatus = ( observationsError as { status?: number } | null )?.status;
  const withoutTaxonIds = String( queryParams.without_taxon_id ?? "" ).split( "," );
  const diagnostics = {
    activeTab: state.activeTab,
    layout,
    canFetch,
    needsPermission,
    isNearby,
    hasNearbyCoords: !!nearbyCoords,
    isConnected,
    status: observationsStatus,
    fetchStatus: observationsFetchStatus,
    isLoading,
    error: observationsError
      ? `${errorStatus ?? ""} ${( observationsError as Error ).message ?? observationsError}`
      : null,
    observationCount: sortedObservations.length,
    totalResults,
    hasTotalBounds: !!totalBounds,
    queryParams: {
      ...queryParams,
      // The My Lifers exclusion can list hundreds of IDs
      without_taxon_id: withoutTaxonIds.length > 20
        ? `${withoutTaxonIds.length} ids`
        : queryParams.without_taxon_id,
    },
  };
  useEffect( ( ) => {
    diagnosticsRef.current = diagnostics;
  } );
  // null on mount, so opening Explore on the observations tab is checked too
  const previousTabRef = useRef<ExploreTab | null>( null );
  useEffect( ( ) => {
    const fromTab = previousTabRef.current;
    previousTabRef.current = state.activeTab;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if ( state.activeTab === OBSERVATIONS_TAB && fromTab !== OBSERVATIONS_TAB ) {
      logger.info( "explore_tab_switch", JSON.stringify( { fromTab, ...diagnosticsRef.current } ) );
      timer = setTimeout( ( ) => {
        const latest = diagnosticsRef.current;
        if ( latest.activeTab === OBSERVATIONS_TAB && latest.observationCount === 0 ) {
          const details = JSON.stringify( { fromTab, ...latest } );
          logger.error( "explore_empty_after_tab_switch", details );
        }
      }, EMPTY_AFTER_SWITCH_MS );
    }
    return ( ) => clearTimeout( timer );
  }, [state.activeTab] );

  useEffect( ( ) => {
    if ( observationsStatus !== "error" ) return;
    logger.error( "explore_observations_query_error", JSON.stringify( diagnosticsRef.current ) );
  }, [observationsStatus] );

  const reload = useCallback( async ( ) => {
    // only refresh results if we're now connected
    const { isConnected: isConnectedNow } = await refresh( );
    if ( isConnectedNow ) {
      handlePullToRefresh( );
    }
  }, [handlePullToRefresh] );

  const baseSearchParams = useMemo( ( ) => {
    // take out the paging and sorting params that only apply to observations
    const {
      order_by: orderBy, order, per_page: perPage, ...filterParams
    } = queryParams;
    return filterParams;
  }, [queryParams] );

  const hotspotSettings = useStore( s => s.layout.hotspotSettings );
  const hotspotParams = useMemo( ( ) => {
    // Only the settings that change the search, so editing the others doesn't
    // rerun it. Picked by key, since settings removed from the app can linger
    // in persisted state.
    const searchSettings = Object.fromEntries( Object.keys( DEFAULT_HOTSPOT_SETTINGS )
      .filter( key => key !== "hotspotRecentAddresses" )
      .map( key => [key, hotspotSettings[key as keyof HotspotSettings]] ) );
    return { ...baseSearchParams, ...searchSettings };
  }, [baseSearchParams, hotspotSettings] );

  const speciesListParams = useMemo( ( ) => ( {
    ...baseSearchParams,
    ...speciesSortToSpeciesCountsParams( state.speciesSortBy ),
  } ), [baseSearchParams, state.speciesSortBy] );

  // Lists in the Explore tab scroll back to where they were when the user returns,
  // as long as the search they show hasn't changed. A search applied whole, like a
  // saved search, starts over at the top even when it matches one scrolled before.
  const scrollRestoreKey = ( list: string, listParams: object ) => (
    isRootExplore
      ? `explore:${list}:${state.appliedSearchCount}:${JSON.stringify( listParams )}`
      : undefined
  );
  // Remounts the lists when a search is applied whole, so they start at the top
  // instead of keeping the previous search's scroll position
  const listKey = String( state.appliedSearchCount );

  const speciesCount = useSpeciesCount(
    baseSearchParams,
    // Only shown in the species view's header
    { enabled: canFetch && state.activeTab === SPECIES_TAB, keyPrefix: SPECIES_COUNT_KEY },
  );
  const queryClient = useQueryClient( );
  // Pulling the species list to refresh updates its count too, so a search that
  // had no results can find some
  const refreshSpeciesCount = useCallback( ( ) => {
    queryClient.invalidateQueries( { queryKey: [SPECIES_COUNT_KEY] } );
  }, [queryClient] );

  const exploreViews: Record<ExploreTab, {
    buttonText: string;
    icon: string;
    label: string;
    text: string;
    value: ExploreTab;
  }> = {
    [OBSERVATIONS_TAB]: {
      buttonText: t( "EXPLORE-OBSERVATIONS" ),
      icon: "observations",
      label: t( "Observations" ),
      text: t( "Individual-encounters-with-organisms" ),
      value: OBSERVATIONS_TAB,
    },
    [IDENTIFY_TAB]: {
      buttonText: t( "IDENTIFY" ),
      icon: "id-agree",
      label: t( "Identify" ),
      text: t( "Identify-observations-one-at-a-time" ),
      value: IDENTIFY_TAB,
    },
    [SPECIES_TAB]: {
      buttonText: t( "EXPLORE-SPECIES" ),
      icon: "species",
      label: t( "Species" ),
      text: t( "Organisms-that-are-identified-to-species" ),
      value: SPECIES_TAB,
    },
    [HOTSPOTS_TAB]: {
      buttonText: t( "EXPLORE-HOTSPOTS" ),
      icon: "location",
      label: t( "Hotspots" ),
      text: t( "Clusters-of-observations-along-a-route" ),
      value: HOTSPOTS_TAB,
    },
    [OBSERVERS_TAB]: {
      buttonText: t( "EXPLORE-OBSERVERS" ),
      icon: "observers",
      label: t( "Observers" ),
      text: t( "iNaturalist-users-who-have-observed" ),
      value: OBSERVERS_TAB,
    },
    [IDENTIFIERS_TAB]: {
      buttonText: t( "EXPLORE-IDENTIFIERS" ),
      icon: "identifiers",
      label: t( "Identifiers" ),
      text: t( "iNaturalist-users-who-have-left-an-identification" ),
      value: IDENTIFIERS_TAB,
    },
    [LIFELIST_TAB]: {
      buttonText: t( "EXPLORE-LIFE-LIST" ),
      icon: "list",
      label: t( "Life-List" ),
      text: t( "Each-species-with-the-date-it-was-first-observed" ),
      value: LIFELIST_TAB,
    },
    [IDENTIFICATIONS_TAB]: {
      buttonText: t( "EXPLORE-IDENTIFICATIONS" ),
      icon: "id-agree",
      label: t( "Identifications" ),
      text: t( "Identifications-people-have-added-to-observations" ),
      value: IDENTIFICATIONS_TAB,
    },
  };
  const exploreViewA11yLabels: Record<ExploreTab, string> = {
    [OBSERVATIONS_TAB]: t( "Observations-View" ),
    [IDENTIFY_TAB]: t( "Identify-View" ),
    [SPECIES_TAB]: t( "Species-View" ),
    [HOTSPOTS_TAB]: t( "Hotspots-View" ),
    [OBSERVERS_TAB]: t( "Observers-View" ),
    [IDENTIFIERS_TAB]: t( "Identifiers-View" ),
    [LIFELIST_TAB]: t( "Life-List-View" ),
    [IDENTIFICATIONS_TAB]: t( "Identifications-View" ),
  };

  const renderPermissionPrompt = ( ) => (
    <View className="flex-1 justify-center p-4">
      <View className="items-center">
        <Body2>{t( "To-view-nearby-organisms-please-enable-location" )}</Body2>
      </View>
      <Button
        className="mt-5"
        text={t( "ALLOW-LOCATION-ACCESS" )}
        accessibilityHint={t( "Opens-location-permission-prompt" )}
        level="focus"
        onPress={requestPermissions}
      />
    </View>
  );

  const renderTabContent = ( ) => {
    switch ( state.activeTab ) {
      case OBSERVATIONS_TAB: {
        const hasNoResults = canFetch && totalResults === 0;
        return (
          <>
            {showMap
              ? (
                <ExploreMapView
                  appliedSearchCount={state.appliedSearchCount}
                  isLoading={isLoading || isPlaceholderData}
                  mapAreaBounds={state.location.placeMode === EXPLORE_PLACE_MODE.MAP_AREA
                    ? state.location.bounds
                    : undefined}
                  nearbyCoords={nearbyCoords}
                  onRedoSearchPress={handleRedoSearchPress}
                  placeMode={state.location.placeMode}
                  placeId={state.location.placeMode === EXPLORE_PLACE_MODE.PLACE
                    ? state.location.place.id
                    : undefined}
                  queryParams={queryParams}
                  restoreView={isRootExplore}
                  totalBounds={totalBounds}
                />
              )
              : (
                <View
                  className={isPlaceholderData
                    ? "flex-1 opacity-50"
                    : "flex-1"}
                >
                  <ObservationsFlashList
                    key={listKey}
                    data={sortedObservations}
                    dataCanBeFetched={canFetch}
                    explore
                    fullWidthGrid={layout !== "list"}
                    handlePullToRefresh={handlePullToRefresh}
                    hideLoadingWheel={!isFetchingNextPage}
                    isFetchingNextPage={isFetchingNextPage}
                    isConnected={isConnected}
                    layout={layout === "list"
                      ? "list"
                      : "grid"}
                    // bit over a misnomer on this prop; in this case it hides the
                    // ID/comments/quality badges that grid results can technically have
                    hideObsUploadStatus={layout !== "list"}
                    obsListKey="ExploreObservations"
                    // Taxonomic order loads everything it sorts itself, and more would land all
                    // over the list
                    onEndReached={byTaxonomy
                      ? noop
                      : fetchNextPage}
                    listHeaderContent={byTaxonomy
                      ? (
                        <TaxonomicOrderNotice
                          kind="observations"
                          loaded={observations.length}
                          limit={EXPLORE_TAXONOMIC_OBSERVATIONS_LIMIT}
                          total={totalResults}
                        />
                      )
                      : null}
                    scrollRestoreKey={scrollRestoreKey(
                      `observations-${layout}`,
                      observationsParams,
                    )}
                    selectable
                    showNoResults={hasNoResults}
                    testID="ExploreObservationsList"
                  />
                </View>
              )}
            <ObservationsViewBar
              layout={layout}
              updateObservationsView={writeLayoutToStorage}
              viewOptions={["map", "grid", "list"]}
            />
            {/* Nothing to sort when there are no results */}
            {!showMap && !hasNoResults && (
              <SortButton
                onPress={() => setShowSortSheet( true )}
                accessibilityLabel={t( "Change-observations-sort-order" )}
              />
            )}
            {!showMap && layout === "grid" && !hasNoResults && (
              <INatIconButton
                icon="tune"
                size={22}
                className="bg-white rounded-full h-[46px] w-[46px] border-[1px] border-lightGray
                  absolute bottom-[76px] z-10 right-5"
                accessibilityLabel={t( "Change-view-options" )}
                onPress={() => setShowGridOverlaysSheet( true )}
                style={DROP_SHADOW}
              />
            )}
            {!showMap && <CombineObservationsBar />}
          </>
        );
      }
      case SPECIES_TAB: {
        const speciesHasNoResults = canFetch && speciesCount === 0;
        return (
          <>
            <ExploreSpeciesView
              key={listKey}
              byTaxonomy={state.speciesSortBy === SPECIES_SORT.TAXONOMY}
              enabled={canFetch}
              isConnected={isConnected}
              onRefresh={refreshSpeciesCount}
              params={speciesListParams}
              scrollRestoreKey={scrollRestoreKey( "species", speciesListParams )}
            />
            {/* Nothing to sort when there are no results */}
            {!speciesHasNoResults && (
              <SortButton
                onPress={() => setShowSortSheet( true )}
                accessibilityLabel={t( "Change-species-sort-order" )}
              />
            )}
          </>
        );
      }
      case HOTSPOTS_TAB:
        return (
          <WildlifeHotspotsScreen
            embedded
            filterParams={hotspotParams}
            exploreV2State={state}
          />
        );
      case IDENTIFY_TAB:
        return (
          <IdentifyView
            key={listKey}
            canFetch={canFetch}
            queryParams={baseSearchParams}
            handleUpdateCount={noop}
          />
        );
      case LIFELIST_TAB:
        return (
          <LifeListView
            key={listKey}
            canFetch={canFetch}
            isConnected={Boolean( isConnected )}
            queryParams={baseSearchParams}
            handleUpdateCount={handleLifeListCount}
            scrollRestoreKey={scrollRestoreKey( "lifelist", baseSearchParams )}
          />
        );
      case OBSERVERS_TAB:
      case IDENTIFIERS_TAB:
        return (
          <ExploreUsersView
            key={`${state.activeTab}:${listKey}`}
            enabled={canFetch}
            isConnected={isConnected}
            params={baseSearchParams}
            scrollRestoreKey={scrollRestoreKey( state.activeTab, baseSearchParams )}
            tab={state.activeTab}
            onCount={state.activeTab === OBSERVERS_TAB
              ? setObserversCount
              : undefined}
          />
        );
      case IDENTIFICATIONS_TAB:
        return (
          <ExploreIdentificationsView
            key={listKey}
            enabled={canFetch}
            params={baseSearchParams}
            onCount={setIdentificationsCount}
            scrollRestoreKey={scrollRestoreKey( "identifications", baseSearchParams )}
          />
        );
      default: {
        // Exhaustiveness check: ts fails if a new tab is added without a case.
        const _exhaustive: never = state.activeTab;
        return null;
      }
    }
  };

  // Every tab can show what it fetched recently offline, from the HTTP cache.
  // Tabs other than observations show the offline notice themselves when
  // nothing's cached.
  const hasCachedResults = state.activeTab !== OBSERVATIONS_TAB
    || sortedObservations.length > 0
    // Still reading what's cached
    || isLoading;

  const renderContent = ( ) => {
    // Before anything else
    // A saved search it excludes was renamed or deleted, or couldn't be loaded
    if ( excludedSpecies.error ) {
      return <ExcludedSpeciesError error={excludedSpecies.error} />;
    }
    if ( !excludedSpeciesReady ) {
      return (
        <View className="flex-1 justify-center items-center">
          <ActivityIndicator testID="ExploreResults.syncingObservedSpecies" />
        </View>
      );
    }
    // Results fetched earlier for this search are still shown, from the cache
    if ( isConnected === false && !hasCachedResults ) {
      return (
        <View className="flex-1">
          <OfflineNotice onPress={reload} />
        </View>
      );
    }
    if ( needsPermission ) {
      return renderPermissionPrompt( );
    }
    const totalCount = {
      [OBSERVATIONS_TAB]: typeof totalResults === "number"
        && t( "X-Observations", { count: totalResults } ),
      [SPECIES_TAB]: typeof speciesCount === "number"
        && t( "X-Species", { count: speciesCount } ),
      [LIFELIST_TAB]: typeof lifeListCount === "number"
        && t( "X-Species", { count: lifeListCount } ),
      [IDENTIFICATIONS_TAB]: typeof identificationsCount === "number"
        && t( "X-Identifications", { count: identificationsCount } ),
      [OBSERVERS_TAB]: typeof observersCount === "number"
        && t( "X-Observers", { count: observersCount } ),
    }[state.activeTab as string];
    // Results that aren't the latest stay shown, saying so above them
    const showConnectionBanner = state.activeTab === OBSERVATIONS_TAB
      && sortedObservations.length > 0
      && !isPlaceholderData
      && ( isConnected === false || refreshFailed || observationsStatus === "error" );
    return (
      <>
        {showConnectionBanner && (
          <ExploreConnectionBanner
            offline={isConnected === false}
            dataUpdatedAt={dataUpdatedAt}
            onRetry={reload}
          />
        )}
        {totalCount && (
          <View className="px-5 pb-2">
            <Body2 testID="ExploreResults.totalCount">{totalCount}</Body2>
          </View>
        )}
        {renderTabContent( )}
      </>
    );
  };

  return (
    <ViewWrapper testID="ExploreResults" wrapperClassName="overflow-hidden">
      <View className="flex-1 overflow-hidden">
        <ExploreHeader
          exploreViewIcon={EXPLORE_VIEW_ICONS[state.activeTab]}
          exploreViewLabel={exploreViewA11yLabels[state.activeTab]}
          onPressChangeView={( ) => setShowViewSheet( true )}
          showBackButton={Boolean( params?.showBackButton )}
        />
        {renderContent( )}
      </View>
      {showSortSheet && state.activeTab === OBSERVATIONS_TAB && (
        <RadioButtonSheet
          headerText={t( "SORT-OBSERVATIONS" )}
          immediate
          radioValues={sortOptions}
          selectedValue={state.sortBy}
          confirm={sortBy => {
            dispatch( {
              type: EXPLORE_ACTION.SET_SORT,
              sortBy: sortBy as OBSERVATIONS_SORT,
            } );
            setShowSortSheet( false );
          }}
          onPressClose={() => setShowSortSheet( false )}
        />
      )}
      {showSortSheet && state.activeTab === SPECIES_TAB && (
        <RadioButtonSheet
          headerText={t( "SORT-SPECIES" )}
          radioValues={speciesSortOptions}
          selectedValue={state.speciesSortBy}
          confirm={speciesSortBy => {
            dispatch( {
              type: EXPLORE_ACTION.SET_SPECIES_SORT,
              speciesSortBy: speciesSortBy as SpeciesCountsSort,
            } );
            setShowSortSheet( false );
          }}
          onPressClose={() => setShowSortSheet( false )}
        />
      )}
      {showGridOverlaysSheet && (
        <GridOverlaysSheet
          onPressClose={() => setShowGridOverlaysSheet( false )}
          showGridOverlays={layout === "grid"}
        />
      )}
      {showViewSheet && (
        <RadioButtonSheet
          immediate
          headerText={t( "EXPLORE" )}
          radioValues={exploreViews}
          selectedValue={state.activeTab}
          confirm={tab => {
            dispatch( {
              type: EXPLORE_ACTION.SET_ACTIVE_TAB,
              tab: tab as ExploreTab,
            } );
            setShowViewSheet( false );
          }}
          onPressClose={() => setShowViewSheet( false )}
          testID="ExploreV2ViewSheet"
        />
      )}
      {renderPermissionsGate( {} )}
    </ViewWrapper>
  );
};

export default ExploreResults;
