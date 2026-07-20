// @flow

import { refresh } from "@react-native-community/netinfo";
import ExploreFiltersModal from "components/Explore/Modals/ExploreFiltersModal";
import {
  Body2,
  Button,
  OfflineNotice,
  RadioButtonSheet,
  ViewWrapper,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import WildlifeHotspotsScreen from "components/WildlifeHotspots/WildlifeHotspotsScreen";
import { PLACE_MODE, useExplore } from "providers/ExploreContext";
import type { Node } from "react";
import React, { useState } from "react";
import {
  useStoredLayout,
  useTranslation,
} from "sharedHooks";

import ExploreHeader from "./Header/ExploreHeader";
import IdentifiersView from "./IdentifiersView";
import IdentifyView from "./IdentifyView";
import ObservationsView from "./ObservationsView";
import ObservationsViewBar from "./ObservationsViewBar";
import ObserversView from "./ObserversView";
import SpeciesView from "./SpeciesView";

const exploreViewIcon = {
  observations: "binoculars",
  identify: "id-agree",
  species: "leaf",
  observers: "observers",
  identifiers: "identifiers",
  hotspots: "location",
};

type Props = {
  canFetch?: boolean, // TODO: change to PLACE_MODE in Typescript
  closeFiltersModal: Function,
  count: Object,
  currentExploreView: string,
  filterByIconicTaxonUnknown: Function,
  handleUpdateCount: Function,
  hasLocationPermissions?: boolean,
  hideBackButton: boolean,
  isConnected: boolean,
  isFetchingHeaderCount: boolean,
  openFiltersModal: Function,
  placeMode: string,
  queryParams: Object,
  renderLocationPermissionsGate: Function,
  requestLocationPermissions: Function,
  setCurrentExploreView: Function,
  showFiltersModal: boolean,
  startFetching: Function,
  updateLocation: Function,
  updateProject: Function,
  updateTaxonFilters: Function,
  updateUser: Function
}

const Explore = ( {
  canFetch,
  closeFiltersModal,
  count,
  currentExploreView,
  filterByIconicTaxonUnknown,
  handleUpdateCount,
  hasLocationPermissions,
  hideBackButton,
  isConnected,
  isFetchingHeaderCount,
  openFiltersModal,
  placeMode,
  queryParams,
  renderLocationPermissionsGate,
  requestLocationPermissions,
  setCurrentExploreView,
  showFiltersModal,
  startFetching,
  updateLocation,
  updateProject,
  updateTaxonFilters,
  updateUser,
}: Props ): Node => {
  const { t } = useTranslation( );
  const { state: exploreState } = useExplore( );
  const hotspotConfig = {
    hotspotClusterRadiusKm: exploreState.hotspotClusterRadiusKm,
    hotspotMaxDetourCandidates: exploreState.hotspotMaxDetourCandidates,
    hotspotObsPerPage: exploreState.hotspotObsPerPage,
    hotspotParkingMinutes: exploreState.hotspotParkingMinutes,
    hotspotBboxPaddingKm: exploreState.hotspotBboxPaddingKm,
  };
  const [showExploreBottomSheet, setShowExploreBottomSheet] = useState( false );
  const { layout, writeLayoutToStorage } = useStoredLayout( "exploreObservationsLayout" );

  const exploreViewA11yLabel = {
    observations: t( "Observations-View" ),
    identify: t( "Identify-View" ),
    species: t( "Species-View" ),
    observers: t( "Observers-View" ),
    identifiers: t( "Identifiers-View" ),
    hotspots: t( "Hotspots-View" ),
  };

  const icon = exploreViewIcon[currentExploreView];
  const a11yLabel = exploreViewA11yLabel[currentExploreView];
  const headerCount = count[currentExploreView];

  const renderHeader = ( ) => (
    <ExploreHeader
      count={headerCount}
      exploreView={currentExploreView}
      exploreViewIcon={icon}
      exploreViewLabel={a11yLabel}
      hasLocationPermissions={hasLocationPermissions}
      hideBackButton={hideBackButton}
      isFetchingHeaderCount={isFetchingHeaderCount}
      onPressCount={( ) => setShowExploreBottomSheet( true )}
      onPressChangeView={( ) => setShowExploreBottomSheet( true )}
      openFiltersModal={openFiltersModal}
      renderLocationPermissionsGate={renderLocationPermissionsGate}
      requestLocationPermissions={requestLocationPermissions}
      updateLocation={updateLocation}
      updateTaxonFilters={updateTaxonFilters}
    />
  );

  const renderMainContent = ( ) => {
    if ( isConnected === false ) {
      return (
        <OfflineNotice
          onPress={() => refresh()}
        />
      );
    }
    // hasLocationPermissions === undefined means we haven't checked for location permissions yet
    if ( placeMode === PLACE_MODE.NEARBY && hasLocationPermissions === false ) {
      return (
        <View className="flex-1 justify-center p-4">
          <View className="items-center">
            <Body2>{t( "To-view-nearby-organisms-please-enable-location" )}</Body2>
          </View>
          <Button
            className="mt-5"
            text={t( "ALLOW-LOCATION-ACCESS" )}
            accessibilityHint={t( "Opens-location-permission-prompt" )}
            level="focus"
            onPress={( ) => requestLocationPermissions()}
          />
        </View>
      );
    }
    return (
      <View className="flex-1">
        {currentExploreView === "observations" && (
          <ObservationsView
            canFetch={canFetch}
            layout={layout}
            queryParams={queryParams}
            handleUpdateCount={handleUpdateCount}
            hasLocationPermissions={hasLocationPermissions}
            renderLocationPermissionsGate={renderLocationPermissionsGate}
            requestLocationPermissions={requestLocationPermissions}
          />
        )}
        {currentExploreView === "identify" && (
          <IdentifyView
            canFetch={canFetch}
            queryParams={queryParams}
            handleUpdateCount={handleUpdateCount}
          />
        )}
        {currentExploreView === "species" && (
          <SpeciesView
            canFetch={canFetch}
            isConnected={isConnected}
            queryParams={queryParams}
            handleUpdateCount={handleUpdateCount}
          />
        )}
        {currentExploreView === "observers" && (
          <ObserversView
            canFetch={canFetch}
            isConnected={isConnected}
            queryParams={queryParams}
            handleUpdateCount={handleUpdateCount}
          />
        )}
        {currentExploreView === "identifiers" && (
          <IdentifiersView
            canFetch={canFetch}
            isConnected={isConnected}
            queryParams={queryParams}
            handleUpdateCount={handleUpdateCount}
          />
        )}
        {currentExploreView === "hotspots" && (
          <WildlifeHotspotsScreen
            embedded
            filterParams={{ ...queryParams, ...hotspotConfig }}
          />
        )}
      </View>
    );
  };

  const renderSheet = () => {
    if ( !showExploreBottomSheet ) {
      return null;
    }
    const values = {
      species: {
        buttonText: t( "EXPLORE-SPECIES" ),
        icon: "species",
        label: t( "Species" ),
        text: t( "Organisms-that-are-identified-to-species" ),
        value: "species",
      },
      observations: {
        buttonText: t( "EXPLORE-OBSERVATIONS" ),
        icon: "observations",
        label: t( "Observations" ),
        text: t( "Individual-encounters-with-organisms" ),
        value: "observations",
      },
      identify: {
        buttonText: t( "IDENTIFY" ),
        icon: "id-agree",
        label: t( "Identify" ),
        text: t( "Identify-observations-one-at-a-time" ),
        value: "identify",
      },
      observers: {
        buttonText: t( "EXPLORE-OBSERVERS" ),
        icon: "observers",
        label: t( "Observers" ),
        text: t( "iNaturalist-users-who-have-observed" ),
        value: "observers",
      },
      identifiers: {
        buttonText: t( "EXPLORE-IDENTIFIERS" ),
        icon: "identifiers",
        label: t( "Identifiers" ),
        text: t( "iNaturalist-users-who-have-left-an-identification" ),
        value: "identifiers",
      },
      hotspots: {
        buttonText: t( "EXPLORE-HOTSPOTS" ),
        icon: "location",
        label: t( "Hotspots" ),
        text: t( "Clusters-of-observations-along-a-route" ),
        value: "hotspots",
      },
    };

    return (
      <RadioButtonSheet
        immediate
        onPressClose={() => setShowExploreBottomSheet( false )}
        headerText={t( "EXPLORE" )}
        hidden={!showExploreBottomSheet}
        confirm={newView => {
          startFetching( );
          setCurrentExploreView( newView );
          setShowExploreBottomSheet( false );
        }}
        radioValues={values}
        selectedValue={currentExploreView}
        testID="ExploreObsViewSheet"
      />
    );
  };

  return (
    <>
      <ViewWrapper testID="Explore" wrapperClassName="overflow-hidden">
        <View className="flex-1 overflow-hidden">
          {renderHeader()}
          {currentExploreView === "observations" && (
            <ObservationsViewBar
              layout={layout}
              updateObservationsView={writeLayoutToStorage}
            />
          )}
          {renderMainContent()}
        </View>
      </ViewWrapper>
      <ExploreFiltersModal
        showModal={showFiltersModal}
        closeModal={closeFiltersModal}
        filterByIconicTaxonUnknown={filterByIconicTaxonUnknown}
        renderLocationPermissionsGate={renderLocationPermissionsGate}
        requestLocationPermissions={requestLocationPermissions}
        updateTaxonFilters={updateTaxonFilters}
        updateLocation={updateLocation}
        updateUser={updateUser}
        updateProject={updateProject}
      />
      {renderSheet()}
    </>
  );
};

export default Explore;
