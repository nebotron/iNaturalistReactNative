import { refresh, useNetInfo } from "@react-native-community/netinfo";
import { useFocusEffect, useRoute } from "@react-navigation/native";
import type { ApiTotalBounds } from "api/types";
import {
  HOTSPOTS_TAB,
  IDENTIFIERS_TAB,
  IDENTIFY_TAB,
  LIFELIST_TAB,
  OBSERVATIONS_TAB,
  OBSERVERS_TAB,
  SPECIES_TAB,
} from "appConstants/tabs";
import classnames from "classnames";
import ExploreV2Header
  from "components/Explore/ExploreV2/components/ExploreV2Header";
import ExploreV2MapView
  from "components/Explore/ExploreV2/components/ExploreV2MapView";
import SaveSearchButton
  from "components/Explore/ExploreV2/components/SaveSearchButton";
import ExploreV2DebugSheet
  from "components/Explore/ExploreV2/ExploreV2DebugSheet";
import type { NearbyCoords }
  from "components/Explore/ExploreV2/helpers/buildQueryParams";
import buildExploreV2QueryParams
  from "components/Explore/ExploreV2/helpers/buildQueryParams";
import savedSearchKey from "components/Explore/ExploreV2/helpers/savedSearchKey";
import ExploreV2SpeciesView
  from "components/Explore/ExploreV2/screens/ExploreV2SpeciesView";
import ExploreV2UsersView
  from "components/Explore/ExploreV2/screens/ExploreV2UsersView";
import useInfiniteExploreScroll
  from "components/Explore/hooks/useInfiniteExploreScroll";
import IdentifyView from "components/Explore/IdentifyView";
import LifeListView from "components/Explore/LifeListView";
import ObservationsViewBar from "components/Explore/ObservationsViewBar";
import ObservationsFlashList from "components/ObservationsFlashList/ObservationsFlashList";
import {
  Body2,
  Button,
  OfflineNotice,
  RadioButtonSheet,
  ViewWrapper,
} from "components/SharedComponents";
import SortButton from "components/SharedComponents/Buttons/SortButton";
import Toast from "components/SharedComponents/Toast";
import { View } from "components/styledComponents";
import WildlifeHotspotsScreen from "components/WildlifeHotspots/WildlifeHotspotsScreen";
import type { ExploreStackScreenProps } from "navigation/types";
import type { ExploreV2Tab } from "providers/ExploreV2Context";
import { EXPLORE_V2_ACTION, EXPLORE_V2_PLACE_MODE, useExploreV2 } from "providers/ExploreV2Context";
import React, { useCallback, useMemo, useState } from "react";
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
import { SAVED_LIMIT } from "stores/createExploreV2SearchesSlice";
import useStore from "stores/useStore";

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

type SaveToast = "added" | "removed" | "limitReached";

const EXPLORE_VIEW_ICONS: Record<ExploreV2Tab, string> = {
  [OBSERVATIONS_TAB]: "binoculars",
  [IDENTIFY_TAB]: "id-agree",
  [SPECIES_TAB]: "leaf",
  [HOTSPOTS_TAB]: "location",
  [OBSERVERS_TAB]: "observers",
  [IDENTIFIERS_TAB]: "identifiers",
  [LIFELIST_TAB]: "list",
};

const noop = ( ) => undefined;

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
  const [saveToast, setSaveToast] = useState<SaveToast | null>( null );
  const savedSearches = useStore( storeState => storeState.exploreSavedSearches.searches );
  const saveSearch = useStore( storeState => storeState.exploreSavedSearches.saveSearch );
  const removeSearch = useStore( storeState => storeState.exploreSavedSearches.removeSearch );
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
          setNearbyCoords( { lat: location.latitude, lng: location.longitude, radius: 1 } );
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
  const showingResults = isConnected !== false && !needsPermission;

  const queryParams = useMemo(
    ( ) => buildExploreV2QueryParams( state, nearbyCoords, currentUserId ),
    [state, nearbyCoords, currentUserId],
  );

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
  };
  const exploreViewA11yLabels: Record<ExploreV2Tab, string> = {
    [OBSERVATIONS_TAB]: t( "Observations-View" ),
    [IDENTIFY_TAB]: t( "Identify-View" ),
    [SPECIES_TAB]: t( "Species-View" ),
    [HOTSPOTS_TAB]: t( "Hotspots-View" ),
    [OBSERVERS_TAB]: t( "Observers-View" ),
    [IDENTIFIERS_TAB]: t( "Identifiers-View" ),
    [LIFELIST_TAB]: t( "Life-List-View" ),
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

  const {
    subject, location, filters, sortBy, speciesSortBy,
  } = state;
  const currentSearchKey = useMemo(
    ( ) => savedSearchKey( {
      subject, location, sortBy, speciesSortBy, filters,
    } ),
    [filters, location, sortBy, speciesSortBy, subject],
  );
  const isSaved = savedSearches.some( saved => saved.key === currentSearchKey );

  const saveToastText = ( toast: SaveToast ) => {
    switch ( toast ) {
      case "added":
        return t( "Added-to-Saved-Searches" );
      case "removed":
        return t( "Removed-from-Saved-Searches" );
      default:
        return t( "Saved-search-not-added-maximum-of-X", { count: SAVED_LIMIT } );
    }
  };

  const handleSavePress = ( ) => {
    if ( isSaved ) {
      removeSearch( currentSearchKey );
      setSaveToast( "removed" );
    } else if ( savedSearches.length >= SAVED_LIMIT ) {
      setSaveToast( "limitReached" );
    } else {
      saveSearch( {
        key: currentSearchKey, subject, location, sortBy, speciesSortBy, filters,
      } );
      setSaveToast( "added" );
    }
  };

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
            filterParams={baseSearchParams}
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
            handleUpdateCount={noop}
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
      default: {
        // Exhaustiveness check: ts fails if a new tab is added without a case.
        const _exhaustive: never = state.activeTab;
        return null;
      }
    }
  };

  const renderContent = ( ) => {
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
        {showingResults
          && state.activeTab !== HOTSPOTS_TAB
          && state.activeTab !== IDENTIFY_TAB
          && (
            <View
              className={classnames(
                "absolute left-5 right-5 z-10 flex-row items-center justify-end",
                state.activeTab === OBSERVATIONS_TAB && showMap
                  ? "bottom-[140px]"
                  : "bottom-[82px]",
              )}
              pointerEvents="box-none"
            >
              {saveToast && (
                <View
                  className="absolute left-0 right-0 items-center"
                  pointerEvents="box-none"
                >
                  <Toast
                    onHide={( ) => setSaveToast( null )}
                    testID="ExploreResults.saveToast"
                    text={saveToastText( saveToast )}
                  />
                </View>
              )}
              <SaveSearchButton
                isSaved={isSaved}
                onPress={handleSavePress}
              />
            </View>
          )}
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
