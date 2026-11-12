import { refresh } from "@react-native-community/netinfo";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { FlashListRef } from "@shopify/flash-list";
import type { ApiTaxon } from "api/types";
import GridOverlaysSheet
  from "components/Explore/ExploreV2/components/GridOverlaysSheet";
import type { ViewOption } from "components/Explore/ObservationsViewBar";
import ObservationsViewBar from "components/Explore/ObservationsViewBar";
import ObservationsFlashList from "components/ObservationsFlashList/ObservationsFlashList";
import {
  AccountCreationCard,
  FiftyObservationCard,
  FiveObservationCard,
  OneObservationCard,
} from "components/OnboardingModal/PivotCards";
import {
  Body1,
  INatIconButton,
  InfiniteScrollLoadingWheel,
  OfflineNotice,
  PerformanceDebugView,
  RadioButtonSheet,
  Tabs,
  ViewWrapper,
} from "components/SharedComponents";
import SortButton from "components/SharedComponents/Buttons/SortButton";
import CustomFlashList from "components/SharedComponents/FlashList/CustomFlashList";
import { ObservationsStatTab, SpeciesStatTab } from "components/SharedComponents/StatTab";
import UsbImportProgress from "components/SharedComponents/UsbImportProgress";
import { View } from "components/styledComponents";
import {
  MY_OBSERVATIONS_ACTION,
  useMyObservations,
} from "providers/MyObservationsContext";
import React, { useCallback, useMemo } from "react";
import Photo from "realmModels/Photo";
import type {
  RealmObservation,
  RealmTaxon,
} from "realmModels/types";
import type { UserPojo } from "realmModels/User";
import type { MyObservationsSort } from "sharedHelpers/observationsSort";
import {
  MY_OBSERVATIONS_SORT_OPTIONS,
  useObservationsSortLabels,
} from "sharedHelpers/observationsSort";
import type { SPECIES_SORT } from "sharedHelpers/speciesSort";
import {
  MY_OBSERVATIONS_SPECIES_SORT_OPTIONS,
  useSpeciesSortLabels,
} from "sharedHelpers/speciesSort";
import { accessibleTaxonName } from "sharedHelpers/taxon";
import { useGridLayout, useLayoutPrefs, useTranslation } from "sharedHooks";
import useFeatureFlag from "sharedHooks/useFeatureFlag";
import { FeatureFlag } from "stores/createFeatureFlagSlice";
import { getShadow } from "styles/global";
import colors from "styles/tailwindColors";
import type { SpeciesCount } from "types/sorting";

import CombineObservationsBar from "./CombineObservationsBar";
import FullScreenActivityIndicator from "./FullScreenActivityIndicator";
import LoginSheet from "./LoginSheet";
import MyObservationsGroupedByIconicTaxaView from "./MyObservationsGroupedByIconicTaxaView";
import MyObservationsMapView from "./MyObservationsMapView";
import { ACTIVE_SHEET } from "./MyObservationsResults";
import MyObservationsSimpleHeader from "./MyObservationsSimpleHeader";
import MyObservationsSmallGridSearchResults from "./MyObservationsSmallGridSearchResults";
import PivotCardObsGridItem from "./PivotCardObsGridItem";
import SearchedTaxonBanner from "./Search/SearchedTaxonBanner";
import SearchEmptyState from "./Search/SearchEmptyState";
import SimpleHeader from "./SimpleHeader";
import SimpleTaxonGridItem from "./SimpleTaxonGridItem";

interface Props {
  activeTab: string;
  currentUser: UserPojo | null;
  fetchFromLastObservation: ( id: number ) => void;
  handleIndividualUploadPress: ( uuid: string ) => void;
  handlePullToRefresh: ( ) => Promise<void>;
  handleSyncButtonPress: ( ) => void;
  hasActiveSearch: boolean;
  isConnected: boolean;
  isFetchingNextPage: boolean;
  layout: ViewOption;
  listRef?: React.RefObject<FlashListRef<RealmObservation> | null>;
  taxaListRef?: React.RefObject<FlashListRef<SpeciesCount> | null>;
  numTotalObservations?: number;
  numTotalTaxa?: number;
  numUnuploadedObservations: number;
  numObsMissingBasics: number;
  numObsMissingLocationOrDate: number;
  numUnuploadedObsNoTaxon: number;
  observationIds: { uuid: string }[];
  observationsSortOptionId: MyObservationsSort;
  onEndReached: ( ) => void;
  onListLayout?: ( ) => void;
  onScroll?: ( ) => void;
  openSheet: ACTIVE_SHEET;
  setActiveTab: ( newTab: string ) => void;
  setObservationsSortOptionId: ( value: MyObservationsSort ) => void;
  setOpenSheet: ( value: ACTIVE_SHEET ) => void;
  setSpeciesSortOptionId: ( value: SPECIES_SORT ) => void;
  showNoResults: boolean;
  showSearchEmptyState: boolean;
  showSearchOfflineNotice: boolean;
  showSpeciesSearchEmptyState: boolean;
  speciesSortOptionId: SPECIES_SORT;
  taxa?: SpeciesCount[];
  updateObservationsView: ( value: string ) => void;
  fetchMoreTaxa: ( ) => void;
  isFetchingTaxa?: boolean;
  // True while the species list is being fetched, including its first page
  isLoadingTaxa?: boolean;
  justFinishedSignup: boolean;
  loggedInWhileInDefaultMode?: boolean;
  refetchTaxa: ( ) => void;
}

interface TaxaFlashListRenderItemProps {
  // I'm pretty sure this is some kind of bug ~~~~kueda 20250108
  // eslint-disable-next-line react/no-unused-prop-types
  item: SpeciesCount;
}

interface TaxaSortOption {
  label: string;
  text?: string;
  value: SPECIES_SORT;
}

interface ObservationsSortOption {
  label: string;
  text?: string;
  value: MyObservationsSort;
}

const DROP_SHADOW = getShadow( {
  offsetHeight: 4,
  elevation: 6,
} );

const STAT_TAB_PADDING = "pt-[10px] px-3 pb-3";

export const OBSERVATIONS_TAB = "observations";
export const TAXA_TAB = "taxa";

const MyObservationsSimple = ( {
  activeTab,
  currentUser,
  fetchFromLastObservation,
  handleIndividualUploadPress,
  handlePullToRefresh,
  handleSyncButtonPress,
  hasActiveSearch,
  isConnected,
  isFetchingNextPage,
  layout,
  listRef,
  numTotalObservations,
  taxaListRef,
  numTotalTaxa,
  numUnuploadedObservations,
  numObsMissingBasics: numUnuploadedObsMissingBasics,
  numObsMissingLocationOrDate,
  numUnuploadedObsNoTaxon,
  observationIds,
  observationsSortOptionId,
  onEndReached,
  onListLayout,
  onScroll,
  openSheet,
  setActiveTab,
  setObservationsSortOptionId,
  setOpenSheet,
  setSpeciesSortOptionId,
  showNoResults,
  showSearchEmptyState,
  showSearchOfflineNotice,
  showSpeciesSearchEmptyState,
  speciesSortOptionId,
  taxa,
  updateObservationsView,
  fetchMoreTaxa,
  isFetchingTaxa,
  isLoadingTaxa,
  justFinishedSignup,
  loggedInWhileInDefaultMode = false,
  refetchTaxa,
}: Props ) => {
  const { isDefaultMode } = useLayoutPrefs( );
  const { t } = useTranslation( );
  const { dispatch } = useMyObservations( );
  // For now, searching from the species tab requires a signed-in user. for logged-out
  // users there's no server-side taxon search to run, since all their obs are local,
  // so tapping a card will continue to navigate to TaxonDetails.
  const canSearchFromSpeciesTab = !!currentUser;
  const myObservationsSmallGridViewEnabled = useFeatureFlag(
    FeatureFlag.MyObservationsSmallGridViewEnabled,
  );
  const viewOptions: ViewOption[] = ["grid", "list"];
  if ( myObservationsSmallGridViewEnabled && currentUser ) {
    viewOptions.push( "smallGrid" );
  }
  if ( currentUser ) {
    viewOptions.push( "map" );
  }
  const speciesSortLabels = useSpeciesSortLabels( );
  const observationsSortLabels = useObservationsSortLabels( );
  const navigation = useNavigation( );
  const route = useRoute( );
  const {
    flashListStyle: taxaFlashListStyleBase,
    gridItemStyle: taxaGridItemStyle,
    numColumns: taxaNumColumns,
  } = useGridLayout( );
  const taxaFlashListStyle = useMemo( ( ) => ( {
    ...taxaFlashListStyleBase,
    paddingTop: 10,
  } ), [taxaFlashListStyleBase] );

  const taxaSortOptions = MY_OBSERVATIONS_SPECIES_SORT_OPTIONS.reduce(
    ( acc, sortBy ) => {
      const { label, text } = speciesSortLabels[sortBy];
      acc[sortBy] = {
        label,
        text,
        value: sortBy,
      };
      return acc;
    },
    {} as Record<SPECIES_SORT, TaxaSortOption>,
  );

  const observationsSortOptions = MY_OBSERVATIONS_SORT_OPTIONS.reduce(
    ( acc, sortBy ) => {
      const { label, text } = observationsSortLabels[sortBy];
      acc[sortBy] = {
        label,
        text,
        value: sortBy,
      };
      return acc;
    },
    {} as Record<MyObservationsSort, ObservationsSortOption>,
  );

  const renderTaxaItem = useCallback( ( { item: speciesCount }: TaxaFlashListRenderItemProps ) => {
    const taxonId = speciesCount.taxon.id;
    const navToTaxonDetails = ( ) => (
      // Again, not sure how to placate TypeScript w/ React Navigation
      navigation.navigate( {
        // Ensure button mashing doesn't open multiple TaxonDetails instances
        key: `${route.key}-TaxonGridItem-TaxonDetails-${taxonId}`,
        name: "TaxonDetails",
        params: { id: taxonId },
      } )
    );

    const searchThisTaxon = ( ) => {
      // fetchSpeciesCounts and fetchTaxaObserved (logged in path) return ApiTaxon-shaped
      // (snake_case) taxa; the logged-out path returns real RealmTaxon (camelCase) objects.
      // SpeciesCount.taxon is only typed as RealmTaxon, so narrow between both
      // shapes the same way SearchMyObservationsTaxon.tsx does.
      const taxon = speciesCount.taxon as ApiTaxon | RealmTaxon;
      const isRealmTaxon = "isValid" in taxon;
      const preferredCommonName = isRealmTaxon
        ? taxon.preferredCommonName
        : taxon.preferred_common_name;
      const photo = isRealmTaxon
        ? taxon.defaultPhoto
        : taxon.default_photo;
      dispatch( {
        type: MY_OBSERVATIONS_ACTION.SET_TAXON_SEARCH,
        searchTaxon: {
          id: taxonId,
          name: taxon.name || "",
          preferredCommonName,
          iconUri: photo?.url,
          iconicTaxonName: taxon.iconic_taxon_name,
        },
        rememberPrevious: true,
      } );
      setActiveTab( OBSERVATIONS_TAB );
    };

    const accessibleName = accessibleTaxonName( speciesCount.taxon, currentUser, t );

    const source = {
      uri: Photo.displayLocalOrRemoteMediumPhoto(
        speciesCount.taxon?.default_photo,
      ),
    };

    // Add a unique key to ensure component recreation
    // so images don't get recycled and show on the wrong taxon
    const itemKey = `taxon-${taxonId}-${source.uri}`;

    return (
      <SimpleTaxonGridItem
        key={itemKey}
        style={taxaGridItemStyle}
        speciesCount={speciesCount}
        canSearchFromSpeciesTab={canSearchFromSpeciesTab}
        navToTaxonDetails={navToTaxonDetails}
        searchThisTaxon={searchThisTaxon}
        accessibleName={accessibleName}
        source={source}
      />
    );
  }, [
    canSearchFromSpeciesTab,
    currentUser,
    dispatch,
    navigation,
    route.key,
    setActiveTab,
    t,
    taxaGridItemStyle,
  ] );

  const taxaFooterComponent = useMemo( ( ) => {
    if ( isFetchingTaxa ) {
      return (
        <InfiniteScrollLoadingWheel
          hideLoadingWheel={false}
          layout={layout}
          isConnected={isConnected}
        />
      );
    }
    if ( !taxa?.length ) {
      return (
        <View className="w-full h-full p-5 justify-center align-center text-center">
          <Body1 className="text-center">{ t( "You-havent-observed-any-species-yet" ) }</Body1>
        </View>
      );
    }
    return <View />;
  }, [
    layout,
    isConnected,
    isFetchingTaxa,
    t,
    taxa?.length,
  ] );

  // The header warning is about location and date only; obs that are just
  // missing a taxon shouldn't trigger it.
  const obsMissingLocationOrDateExist = numObsMissingLocationOrDate > 0;

  // if user is not logged in, we'll consider all obs 'uploadable' to shepherd people to login flow
  const numUploadableObservations = isDefaultMode && !!currentUser
    ? numUnuploadedObservations - numUnuploadedObsMissingBasics
    : numUnuploadedObservations;

  // The tabs show the total counts, so they live in the list header and scroll
  // off the top with the list whenever there's a list to scroll
  const tabsHeader = (
    <Tabs
      activeColor={String( colors?.inatGreen )}
      activeId={activeTab}
      tabs={[
        {
          id: OBSERVATIONS_TAB,
          text: t( "Observations" ),
          onPress: () => setActiveTab( OBSERVATIONS_TAB ),
          renderComponent: ( ) => (
            <ObservationsStatTab
              count={numTotalObservations}
              wrapperClassName={STAT_TAB_PADDING}
            />
          ),
        },
        {
          id: TAXA_TAB,
          text: t( "Species" ),
          onPress: () => setActiveTab( TAXA_TAB ),
          renderComponent: ( ) => (
            <SpeciesStatTab
              count={numTotalTaxa}
              wrapperClassName={STAT_TAB_PADDING}
            />
          ),
        },
      ]}
    />
  );

  const observationsListShown = !showSearchOfflineNotice
    && !showSearchEmptyState
    && layout !== "map"
    && !( layout === "smallGrid" && isConnected === false );
  const listShowsTabs = activeTab === OBSERVATIONS_TAB
    ? observationsListShown
    : !!taxa?.length;

  const observationsHeader = ( ( ) => {
    if ( layout !== "grid" ) {
      return (
        <>
          {tabsHeader}
          <SimpleHeader
            isConnected={isConnected}
            obsMissingLocationOrDateExist={obsMissingLocationOrDateExist}
            numTotalObservations={numTotalObservations}
          />
        </>
      );
    }

    const TARGET_SPACING = 10;

    // our HALF_GUTTER margin value is 7.5, so when we try to cancel it out around announcements we
    // can get odd rounding behavior that causes 1px margins. Using Math.ceil accounts for this.
    return (
      <View
        style={{
          marginTop: -Math.ceil( taxaFlashListStyleBase.paddingTop ),
          marginLeft: -Math.ceil( taxaFlashListStyleBase.paddingLeft ),
          marginRight: -Math.ceil( taxaFlashListStyleBase.paddingRight ),
          marginBottom: TARGET_SPACING - taxaFlashListStyleBase.paddingTop,
        }}
      >
        {tabsHeader}
        <SimpleHeader
          isConnected={isConnected}
          obsMissingLocationOrDateExist={obsMissingLocationOrDateExist}
          numTotalObservations={numTotalObservations}
        />
      </View>
    );
  } )( );

  const dataFilledWithEmptyBoxes = useMemo( ( ) => {
    const data = observationIds;
    // In grid layout fill up to 8 items to make sure the grid is filled
    // but don't add the empty boxes at the end of a long existing list
    if ( layout === "grid" && data.length < 8 && !hasActiveSearch ) {
    // Fill up to 8 items to make sure the grid is filled
      const emptyBoxes = new Array( 8 - ( data.length % 8 ) ).fill( { empty: true } );
      // Add random id to empty boxes to ensure they are unique
      const emptyBoxesWithId = emptyBoxes.map( ( box, index ) => ( {
        ...box,
        id: `empty-${index}`,
      } ) );
      return [...data, ...emptyBoxesWithId];
    }
    return data;
  }, [observationIds, layout, hasActiveSearch] );

  const renderOfflineFallback = ( onPress: ( ) => void ) => (
    <View className="flex-1 items-center justify-center">
      <OfflineNotice onPress={onPress} />
    </View>
  );

  const renderMapView = ( ) => {
    if ( isConnected === false ) {
      return renderOfflineFallback( ( ) => refresh( ) );
    }
    return (
      <MyObservationsMapView
        isConnected={isConnected}
        userId={currentUser?.id}
      />
    );
  };

  const renderSmallGridView = ( ) => {
    if ( isConnected === false ) {
      return renderOfflineFallback( ( ) => refresh( ) );
    }
    // searching while in small grid view should show a flat grid
    if ( hasActiveSearch ) {
      return (
        <MyObservationsSmallGridSearchResults
          handlePullToRefresh={handlePullToRefresh}
          isFetchingNextPage={isFetchingNextPage}
          listHeaderContent={observationsHeader}
          observationIds={observationIds}
          onEndReached={onEndReached}
        />
      );
    }
    return (
      <MyObservationsGroupedByIconicTaxaView
        handlePullToRefresh={handlePullToRefresh}
        listHeaderContent={observationsHeader}
      />
    );
  };

  const renderObservations = ( ) => {
    if ( layout === "map" ) { return renderMapView( ); }
    if ( layout === "smallGrid" ) { return renderSmallGridView( ); }
    return (
      <ObservationsFlashList
        data={dataFilledWithEmptyBoxes}
        dataCanBeFetched={!!currentUser}
        fullWidthGrid={layout === "grid"}
        fetchFromLastObservation={fetchFromLastObservation}
        handlePullToRefresh={handlePullToRefresh}
        handleIndividualUploadPress={handleIndividualUploadPress}
        hideLoadingWheel={!isFetchingNextPage}
        hideMetadata={isDefaultMode}
        hideObsUploadStatus={!currentUser}
        hideObsStatus={!currentUser}
        isSimpleObsStatus={isDefaultMode}
        hideRGLabel={!isDefaultMode || !currentUser}
        isFetchingNextPage={isFetchingNextPage}
        isConnected={isConnected}
        obsListKey="MyObservations"
        layout={layout}
        onEndReached={onEndReached}
        onLayout={onListLayout}
        onScroll={onScroll}
        ref={listRef}
        selectable
        showNoResults={showNoResults}
        testID="MyObservationsAnimatedList"
        listHeaderContent={observationsHeader}
      />
    );
  };

  const renderObservationsTabContent = ( ) => {
    if ( showSearchOfflineNotice ) {
      return renderOfflineFallback( ( ) => refresh( ) );
    }
    if ( showSearchEmptyState ) {
      return <SearchEmptyState />;
    }
    return (
      <>
        { renderObservations( ) }
        <ObservationsViewBar
          layout={layout}
          updateObservationsView={updateObservationsView}
          viewOptions={viewOptions}
        />
        {layout !== "map" && (
          <SortButton
            onPress={() => setOpenSheet( ACTIVE_SHEET.SORT )}
            accessibilityLabel={t( "Change-observations-sort-order" )}
          />
        )}
        {layout === "grid" && (
          <INatIconButton
            icon="tune"
            size={22}
            className="bg-white rounded-full h-[46px] w-[46px] border-[1px] border-lightGray
              absolute bottom-[76px] z-10 right-5"
            accessibilityLabel={t( "Change-view-options" )}
            onPress={() => setOpenSheet( ACTIVE_SHEET.VIEW_OPTIONS )}
            style={DROP_SHADOW}
          />
        )}
        <CombineObservationsBar />
      </>
    );
  };

  const renderOfflineNotice = ( ) => {
    if ( isConnected === false ) {
      return (
        <View className="flex-1 items-center justify-center">
          <OfflineNotice onPress={refetchTaxa} />
        </View>
      );
    }
    return null;
  };

  const renderEmptyTaxaContent = ( ) => {
    if ( showSpeciesSearchEmptyState ) {
      return <SearchEmptyState />;
    }
    if ( isLoadingTaxa && isConnected !== false ) {
      return <FullScreenActivityIndicator />;
    }
    return renderOfflineNotice( );
  };

  function showOfflineAlert( ) { }

  const handleSpeciesSortConfirm = ( optionId: SPECIES_SORT ) => {
    if ( currentUser && !isConnected ) {
      showOfflineAlert( );
      return;
    }
    setSpeciesSortOptionId( optionId );

    // scroll to the top of the newly sorted list
    // the timeout ensures that the scroll happens after data is re-sorted for logged-out users
    setTimeout( () => {
      if ( taxaListRef?.current ) {
        taxaListRef.current.scrollToOffset( { offset: 0, animated: true } );
      }
    }, 0 );

    setOpenSheet( ACTIVE_SHEET.NONE );
  };

  const handleObservationsSortConfirm = ( optionId: MyObservationsSort ) => {
    if ( currentUser && !isConnected ) {
      showOfflineAlert( );
      return;
    }
    setObservationsSortOptionId( optionId );

    // scroll to the top of the newly sorted list
    setTimeout( () => {
      if ( listRef?.current ) {
        listRef.current.scrollToOffset( { offset: 0, animated: true } );
      }
    }, 0 );

    setOpenSheet( ACTIVE_SHEET.NONE );
  };

  const handlePivotCardGridItemPress = ( ) => {
    const { uuid } = observationIds[0];
    navigation.navigate( {
      key: `Obs-0-${uuid}`,
      name: "ObsDetails",
      params: { uuid },
    } );
  };

  return (
    <>
      <ViewWrapper>
        <MyObservationsSimpleHeader
          currentUser={currentUser}
          isConnected={isConnected}
          numUploadableObservations={numUploadableObservations}
          numUnuploadedObsNoTaxon={numUnuploadedObsNoTaxon}
          handleSyncButtonPress={handleSyncButtonPress}
        />
        { !listShowsTabs && tabsHeader }
        <SearchedTaxonBanner onBack={( ) => setActiveTab( TAXA_TAB )} />
        { activeTab === OBSERVATIONS_TAB && renderObservationsTabContent( ) }
        { ( activeTab === TAXA_TAB && taxa.length > 0 ) && (
          <>
            <CustomFlashList
              ref={taxaListRef}
              canFetch={!!currentUser}
              contentContainerStyle={taxaFlashListStyle}
              data={taxa}
              hideLoadingWheel
              isConnected={isConnected}
              keyExtractor={(
                item: SpeciesCount,
              ) => `${item.taxon.id}-${item?.taxon?.default_photo?.url || "no-photo"}`}
              layout="grid"
              numColumns={taxaNumColumns}
              renderItem={renderTaxaItem}
              totalResults={numTotalTaxa}
              onEndReached={
                currentUser
                  ? fetchMoreTaxa
                  : undefined
              }
              refreshing={isFetchingTaxa}
              ListHeaderComponent={(
                <View
                  style={{
                    marginTop: -taxaFlashListStyle.paddingTop,
                    marginLeft: -Math.ceil( taxaFlashListStyle.paddingLeft ),
                    marginRight: -Math.ceil( taxaFlashListStyle.paddingRight ),
                    marginBottom: taxaFlashListStyle.paddingTop,
                  }}
                >
                  {tabsHeader}
                </View>
              )}
              ListFooterComponent={taxaFooterComponent}
            />
            <SortButton
              onPress={() => setOpenSheet( ACTIVE_SHEET.SORT )}
              accessibilityLabel={t( "Change-species-sort-order" )}
            />
          </>
        )}
        { ( activeTab === TAXA_TAB && taxa.length === 0 ) && renderEmptyTaxaContent( ) }
      </ViewWrapper>
      {openSheet === ACTIVE_SHEET.SORT && activeTab === OBSERVATIONS_TAB && (
        <RadioButtonSheet
          headerText={t( "SORT-OBSERVATIONS" )}
          immediate
          radioValues={observationsSortOptions}
          selectedValue={observationsSortOptionId}
          confirm={optionId => handleObservationsSortConfirm( optionId as MyObservationsSort )}
          onPressClose={() => setOpenSheet( ACTIVE_SHEET.NONE )}
        />
      )}
      {openSheet === ACTIVE_SHEET.SORT && activeTab === TAXA_TAB && (
        <RadioButtonSheet
          headerText={t( "SORT-SPECIES" )}
          radioValues={taxaSortOptions}
          selectedValue={speciesSortOptionId}
          confirm={optionId => handleSpeciesSortConfirm( optionId as SPECIES_SORT )}
          onPressClose={() => setOpenSheet( ACTIVE_SHEET.NONE )}
        />
      )}
      {openSheet === ACTIVE_SHEET.VIEW_OPTIONS && (
        <GridOverlaysSheet
          myObs
          onPressClose={() => setOpenSheet( ACTIVE_SHEET.NONE )}
          showGridOverlays
        />
      )}
      {openSheet === ACTIVE_SHEET.LOGIN && <LoginSheet setShowLoginSheet={setOpenSheet} />}
      <UsbImportProgress />
      {isDefaultMode && (
        <>
          {/* These four cards should show only in default mode */}
          <OneObservationCard
            triggerCondition={numTotalObservations === 1}
            imageComponentOptions={{
              onImageComponentPress: handlePivotCardGridItemPress,
              accessibilityHint: t( "Navigates-to-observation-details" ),
              imageComponent: observationIds.length
                ? (
                  <PivotCardObsGridItem
                    uuid={observationIds[0].uuid}
                  />
                )
                : null,
            }}
          />
          <FiveObservationCard triggerCondition={numTotalObservations === 5} />
          <FiftyObservationCard
            triggerCondition={
              loggedInWhileInDefaultMode && !!currentUser && numTotalObservations >= 50
            }
          />
          <AccountCreationCard
            triggerCondition={
              justFinishedSignup && !!currentUser && numTotalObservations < 20
            }
          />
        </>
      )}
      <PerformanceDebugView
        showListMetrics
        showScrollMetrics
        position="bottom-left"
      />
    </>
  );
};

export default MyObservationsSimple;
