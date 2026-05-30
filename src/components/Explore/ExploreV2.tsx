import { refresh } from "@react-native-community/netinfo";
import { useNavigation } from "@react-navigation/native";
import {
  Body2,
  Button,
  OfflineNotice,
  ViewWrapper,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import { PLACE_MODE } from "providers/ExploreContext";
import React from "react";
import {
  useStoredLayout,
  useTranslation,
} from "sharedHooks";
import type { RenderLocationPermissionsGateFunction } from "sharedHooks/useLocationPermission";

import IdentifiersView from "./IdentifiersView";
import ObservationsView from "./ObservationsView";
import ObservationsViewBar from "./ObservationsViewBar";
import ObserversView from "./ObserversView";
import SpeciesView from "./SpeciesView";

enum EXPLORE_VIEW {
  OBSERVATIONS = "observations",
  IDENTIFIERS = "identifiers",
  OBSERVERS = "observers",
  SPECIES = "species"
}

enum EXPLORE_OBSERVATIONS_LAYOUT {
  GRID = "grid",
  LIST = "list",
  MAP = "map"
}

interface Props {
  canFetch?: boolean;
  currentExploreView: EXPLORE_VIEW;
  handleUpdateCount: ( exploreView: EXPLORE_VIEW, totalResults: number ) => void;
  hasLocationPermissions?: boolean;
  isConnected: boolean;
  placeMode: string;
  queryParams: object;
  renderLocationPermissionsGate: RenderLocationPermissionsGateFunction;
  requestLocationPermissions: ( ) => void;
}

const ExploreV2 = ( {
  canFetch,
  currentExploreView,
  handleUpdateCount,
  hasLocationPermissions,
  isConnected,
  placeMode,
  queryParams,
  renderLocationPermissionsGate,
  requestLocationPermissions,
}: Props ) => {
  const navigation = useNavigation();
  const { t } = useTranslation( );
  const { layout, writeLayoutToStorage } = useStoredLayout( "exploreObservationsLayout" ) as {
    layout: EXPLORE_OBSERVATIONS_LAYOUT | null;
    writeLayoutToStorage: ( newValue: EXPLORE_OBSERVATIONS_LAYOUT ) => void;
  };

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
        {currentExploreView === EXPLORE_VIEW.OBSERVATIONS && (
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
        {currentExploreView === EXPLORE_VIEW.SPECIES && (
          <SpeciesView
            canFetch={canFetch}
            isConnected={isConnected}
            queryParams={queryParams}
            handleUpdateCount={handleUpdateCount}
          />
        )}
        {currentExploreView === EXPLORE_VIEW.OBSERVERS && (
          <ObserversView
            canFetch={canFetch}
            isConnected={isConnected}
            queryParams={queryParams}
            handleUpdateCount={handleUpdateCount}
          />
        )}
        {currentExploreView === EXPLORE_VIEW.IDENTIFIERS && (
          <IdentifiersView
            canFetch={canFetch}
            isConnected={isConnected}
            queryParams={queryParams}
            handleUpdateCount={handleUpdateCount}
          />
        )}
      </View>
    );
  };

  return (
    <>
      <ViewWrapper testID="ExploreV2" wrapperClassName="overflow-hidden">
        <View className="flex-1 overflow-hidden">
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.navigate( "ExploreFilters" )}
          >
            {/* eslint-disable-next-line i18next/no-literal-string */}
            <Body2>TODO: Header Link to Filters</Body2>
          </Pressable>
          {currentExploreView === "observations" && (
            <ObservationsViewBar
              layout={layout}
              updateObservationsView={writeLayoutToStorage}
            />
          )}
          {renderMainContent()}
        </View>
      </ViewWrapper>
      {/*
        Leaving this here so that it is easier to reason about differences between Explore
        and ExploreV2.
      */}
      {null}
    </>
  );
};

export default ExploreV2;
