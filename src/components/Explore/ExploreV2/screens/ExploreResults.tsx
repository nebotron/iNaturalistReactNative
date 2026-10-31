import { refresh, useNetInfo } from "@react-native-community/netinfo";
import { useFocusEffect, useRoute } from "@react-navigation/native";
import { isEbirdEnabled } from "api/ebird";
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
import EbirdResults from "components/Explore/EbirdResults";
import ExploreV2Header
  from "components/Explore/ExploreV2/components/ExploreV2Header";
import ExploreV2MapView
  from "components/Explore/ExploreV2/components/ExploreV2MapView";
import GridOverlaysSheet
  from "components/Explore/ExploreV2/components/GridOverlaysSheet";
import ExploreV2DebugSheet
  from "components/Explore/ExploreV2/ExploreV2DebugSheet";
import type { NearbyCoords }
  from "components/Explore/ExploreV2/helpers/buildQueryParams";
import buildExploreV2QueryParams
  from "components/Explore/ExploreV2/helpers/buildQueryParams";
import ExploreV2IdentificationsView
  from "components/Explore/ExploreV2/screens/ExploreV2IdentificationsView";
import ExploreV2SpeciesView
  from "components/Explore/ExploreV2/screens/ExploreV2SpeciesView";
import ExploreV2UsersView
  from "components/Explore/ExploreV2/screens/ExploreV2UsersView";
import useInfiniteExploreScroll
  from "components/Explore/hooks/useInfiniteExploreScroll";
import IdentifyView from "components/Explore/IdentifyView";
import LifeListView from "components/Explore/LifeListView";
import ObservationsViewBar from "components/Explore/ObservationsViewBar";
import {
  OfflineMapView,
  OfflineObservationsView,
  OfflineSpeciesView,
  useOfflineExploreResults,
} from "components/Explore/OfflineExplore";
import ObservationsFlashList from "components/ObservationsFlashList/ObservationsFlashList";
import {
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
import type { ExploreV2Tab } from "providers/ExploreV2Context";
import { EXPLORE_V2_ACTION, EXPLORE_V2_PLACE_MODE, useExploreV2 } from "providers/ExploreV2Context";
import React, { useCallback, useMemo, useState } from "react";
import type { BoundingBox } from "react-native-maps";
import type { OBSERVATIONS_SORT } from "sharedHelpers/observationsSort";
import {
  OBSERVATIONS_SORT_OPTIONS,
  useObservationsSortLabels,
} from "sharedHelpers/observationsSort";
import type { SPECIES_SORT } from "sharedHelpers/speciesSort";
import {
  EXPLORE_SPECIES_SORT_OPTIONS,
  speciesSortToApiParams,
  useSpeciesSortLabels,
} from "sharedHelpers/speciesSort";
import { useTranslation } from "sharedHooks";
import useCurrentUser from "sharedHooks/useCurrentUser";
import useLocationPermission from "sharedHooks/useLocationPermission";
import useSpeciesCount from "sharedHooks/useSpeciesCount";
import useStoredLayout from "sharedHooks/useStoredLayout";
import useStore from "stores/useStore";
import { getShadow } from "styles/global";

// Please don't change this to an aliased path or the e2e mock will not get
// used in our e2e tests on Github Actions
import fetchCoarseUserLocation from "../../../../sharedHelpers/fetchCoarseUserLocation";
import {
  getLatestTrackedLocation,
} from "../../../../sharedHelpers/locationHistoryTracker";

interface SortOption<SortValue> {
  label: string;
  text: string;
  value: SortValue;
}

const EXPLORE_VIEW_ICONS: Record<ExploreV2Tab, string> = {
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

const DROP_SHADOW = getShadow( {
  offsetHeight: 4,
  elevation: 6,
} );

const ExploreResults = ( ) => {
  const { dispatch, state } = useExploreV2( );
  const { params } = useRoute<ExploreStackScreenProps<"ExploreResults">["route"]>( );
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
  const observationsSortLabels = useObservationsSortLabels( );
  const speciesSortLabels = useSpeciesSortLabels( );
  const { layout, writeLayoutToStorage } = useStoredLayout( "exploreV2ObservationsLayout" );

  const showMap = layout === "map";

  const sortOptions = OBSERVATIONS_SORT_OPTIONS.reduce(
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
    {} as Record<SPECIES_SORT, SortOption<SPECIES_SORT>>,
  );

  const isNearby = state.location.placeMode === EXPLORE_V2_PLACE_MODE.NEARBY;
  const [nearbyCoords, setNearbyCoords] = useState<NearbyCoords | undefined>( undefined );

  useFocusEffect( useCallback( ( ) => {
    let cancelled = false;
    if ( isNearby && hasBlockedPermissions ) {
      // perms blocked: fall back to worldwide
      dispatch( { type: EXPLORE_V2_ACTION.SET_LOCATION_WORLDWIDE } );
    } else if ( isNearby && hasPermissions === true && nearbyCoords === undefined ) {
      getLatestTrackedLocation( ).then(
        tracked => tracked ?? fetchCoarseUserLocation( ),
      ).then( location => {
        if ( cancelled ) return;
        if ( typeof location?.latitude === "number" ) {
          setNearbyCoords( { lat: location.latitude, lng: location.longitude } );
        } else {
          // Perms granted but no fix — fall back to worldwide.
          dispatch( { type: EXPLORE_V2_ACTION.SET_LOCATION_WORLDWIDE } );
        }
      } );
    }
    return ( ) => { cancelled = true; };
  }, [isNearby, hasPermissions, hasBlockedPermissions, nearbyCoords, dispatch] ) );

  const handleCurrentLocationPress = useCallback(
    ( ) => dispatch( { type: EXPLORE_V2_ACTION.SET_LOCATION_NEARBY } ),
    [dispatch],
  );

  const handleRedoSearchPress = useCallback(
    ( bounds: ApiTotalBounds ) => dispatch( {
      type: EXPLORE_V2_ACTION.SET_LOCATION_MAP_AREA,
      bounds,
    } ),
    [dispatch],
  );

  const needsPermission = isNearby && hasPermissions === false && !hasBlockedPermissions;
  const nearbyResolved = !isNearby || nearbyCoords !== undefined;
  const canFetch = !needsPermission && nearbyResolved;

  const queryParams = useMemo(
    ( ) => buildExploreV2QueryParams( state, nearbyCoords, currentUserId ),
    [state, nearbyCoords, currentUserId],
  );

  const offlineResults = useOfflineExploreResults( queryParams );
  // Offline map bounds narrow the offline list; they reset when the filters change
  const [offlineMapArea, setOfflineMapArea] = useState<{
    params: typeof queryParams;
    bounds: BoundingBox;
  }>( );
  const offlineListParams = useMemo( ( ) => {
    if ( offlineMapArea?.params !== queryParams ) return queryParams;
    const { southWest, northEast } = offlineMapArea.bounds;
    return {
      ...queryParams,
      swlat: southWest.latitude,
      swlng: southWest.longitude,
      nelat: northEast.latitude,
      nelng: northEast.longitude,
    };
  }, [offlineMapArea, queryParams] );
  const offlineListResults = useOfflineExploreResults( offlineListParams );

  const {
    fetchNextPage,
    isFetchingNextPage,
    isLoading,
    handlePullToRefresh,
    observations,
    totalBounds,
    totalResults,
  } = useInfiniteExploreScroll( { params: queryParams, enabled: canFetch } );

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
  const hotspotParams = useMemo(
    ( ) => ( { ...baseSearchParams, ...hotspotSettings } ),
    [baseSearchParams, hotspotSettings],
  );

  const speciesListParams = useMemo( ( ) => ( {
    ...baseSearchParams,
    ...speciesSortToApiParams( state.speciesSortBy ),
  } ), [baseSearchParams, state.speciesSortBy] );

  const speciesCount = useSpeciesCount(
    baseSearchParams,
    { enabled: canFetch, keyPrefix: "exploreV2SpeciesCount" },
  );

  const exploreViews: Record<ExploreV2Tab, {
    buttonText: string;
    icon: string;
    label: string;
    text: string;
    value: ExploreV2Tab;
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
  const exploreViewA11yLabels: Record<ExploreV2Tab, string> = {
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
                <ExploreV2MapView
                  appliedSearchCount={state.appliedSearchCount}
                  isLoading={isLoading}
                  mapAreaBounds={state.location.placeMode === EXPLORE_V2_PLACE_MODE.MAP_AREA
                    ? state.location.bounds
                    : undefined}
                  nearbyCoords={nearbyCoords}
                  onCurrentLocationPress={handleCurrentLocationPress}
                  onRedoSearchPress={handleRedoSearchPress}
                  placeMode={state.location.placeMode}
                  queryParams={queryParams}
                  totalBounds={totalBounds}
                />
              )
              : (
                <ObservationsFlashList
                  data={observations}
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
                  listHeaderContent={<EbirdResults enabled={canFetch} params={queryParams} />}
                  // bit over a misnomer on this prop; in this case it hides the
                  // ID/comments/quality badges that grid results can technically have
                  hideObsUploadStatus={layout !== "list"}
                  obsListKey="ExploreV2Observations"
                  onEndReached={fetchNextPage}
                  showNoResults={hasNoResults}
                  testID="ExploreV2ObservationsList"
                />
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
            {!showMap && ( isEbirdEnabled( ) || ( layout === "grid" && !hasNoResults ) ) && (
              <INatIconButton
                icon="layers"
                size={22}
                className="bg-white rounded-full h-[46px] w-[46px] border-[1px] border-lightGray
                  absolute bottom-[76px] z-10 right-5"
                accessibilityLabel={t( "Change-view-options" )}
                onPress={() => setShowGridOverlaysSheet( true )}
                style={DROP_SHADOW}
              />
            )}
          </>
        );
      }
      case SPECIES_TAB: {
        const speciesHasNoResults = canFetch && speciesCount === 0;
        return (
          <>
            <ExploreV2SpeciesView
              enabled={canFetch}
              isConnected={isConnected}
              params={speciesListParams}
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
            canFetch={canFetch}
            queryParams={baseSearchParams}
            handleUpdateCount={noop}
          />
        );
      case LIFELIST_TAB:
        return (
          <LifeListView
            canFetch={canFetch}
            isConnected={Boolean( isConnected )}
            queryParams={baseSearchParams}
            handleUpdateCount={handleLifeListCount}
          />
        );
      case OBSERVERS_TAB:
      case IDENTIFIERS_TAB:
        return (
          <ExploreV2UsersView
            key={state.activeTab}
            enabled={canFetch}
            isConnected={isConnected}
            params={baseSearchParams}
            tab={state.activeTab}
          />
        );
      case IDENTIFICATIONS_TAB:
        return (
          <ExploreV2IdentificationsView
            enabled={canFetch}
            params={baseSearchParams}
            onCount={setIdentificationsCount}
          />
        );
      default: {
        // Exhaustiveness check: ts fails if a new tab is added without a case.
        const _exhaustive: never = state.activeTab;
        return null;
      }
    }
  };

  const renderContent = ( ) => {
    if ( isConnected === false && offlineResults && state.activeTab === OBSERVATIONS_TAB ) {
      // Same views as online; the map counts the whole search, the list its map area
      const offlineCount = ( showMap
        ? offlineResults
        : offlineListResults )?.results.length || 0;
      return (
        <>
          <Body2 className="px-5 pb-2" testID="ExploreResults.offlineCount">
            {t( "X-Observations", { count: offlineCount } )}
          </Body2>
          {showMap
            ? (
              <OfflineMapView
                queryParams={queryParams}
                onBoundsChange={bounds => setOfflineMapArea( { params: queryParams, bounds } )}
              />
            )
            : <OfflineObservationsView layout={layout} queryParams={offlineListParams} />}
          <ObservationsViewBar
            layout={layout}
            updateObservationsView={writeLayoutToStorage}
            viewOptions={["map", "grid", "list"]}
          />
          {!showMap && offlineCount > 0 && (
            <SortButton
              onPress={() => setShowSortSheet( true )}
              accessibilityLabel={t( "Change-observations-sort-order" )}
            />
          )}
        </>
      );
    }
    if ( isConnected === false && offlineResults && state.activeTab === SPECIES_TAB ) {
      return (
        <>
          <OfflineSpeciesView queryParams={speciesListParams} />
          <SortButton
            onPress={() => setShowSortSheet( true )}
            accessibilityLabel={t( "Change-species-sort-order" )}
          />
        </>
      );
    }
    if ( isConnected === false ) {
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
    }[state.activeTab as string];
    return (
      <>
        {totalCount && (
          <Body2 className="px-5 pb-2" testID="ExploreResults.totalCount">
            {totalCount}
          </Body2>
        )}
        {renderTabContent( )}
        <ExploreV2DebugSheet />
      </>
    );
  };

  return (
    <ViewWrapper testID="ExploreResults" wrapperClassName="overflow-hidden">
      <View className="flex-1 overflow-hidden">
        <ExploreV2Header
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
          radioValues={sortOptions}
          selectedValue={state.sortBy}
          confirm={sortBy => {
            dispatch( {
              type: EXPLORE_V2_ACTION.SET_SORT,
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
              type: EXPLORE_V2_ACTION.SET_SPECIES_SORT,
              speciesSortBy: speciesSortBy as SPECIES_SORT,
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
              type: EXPLORE_V2_ACTION.SET_ACTIVE_TAB,
              tab: tab as ExploreV2Tab,
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
