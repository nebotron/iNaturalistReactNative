import { useNavigation, useRoute } from "@react-navigation/native";
import type { ApiPlace, ApiProject, ApiTaxon } from "api/types";
import { View } from "components/styledComponents";
import type { TabStackScreenProps } from "navigation/types";
import {
  EXPLORE_ACTION,
  ExploreProvider,
  exploreReducer,
  useExplore,
} from "providers/ExploreContext";
import React, { useCallback } from "react";
import type { RealmTaxon } from "realmModels/types";
import { useLocationPermission } from "sharedHooks";
import useStore from "stores/useStore";

import ExploreLocationSearch from "./SearchScreens/ExploreLocationSearch";
import ExploreProjectSearch from "./SearchScreens/ExploreProjectSearch";
import ExploreTaxonSearch from "./SearchScreens/ExploreTaxonSearch";
import ExploreUserSearch from "./SearchScreens/ExploreUserSearch";

const ExploreSearchContainerWithContext = () => {
  const navigation = useNavigation<TabStackScreenProps<"ExploreSearch">["navigation"]>();
  const { params } = useRoute<TabStackScreenProps<"ExploreSearch">["route"]>();
  const { state, dispatch, defaultExploreLocation } = useExplore( );
  const setRootStoredParams = useStore( storeState => storeState.setRootStoredParams );

  const {
    hasPermissions,
    renderPermissionsGate,
    requestPermissions,
  } = useLocationPermission( );

  const initialSearchMode = params?.initialSearchMode || "none";

  const closeModal = () => {
    navigation.goBack();
  };

  const updateTaxon = (
    taxon: {
      name: string;
    } | null,
  ) => {
    console.log( "Not implemented in ExploreV2 yet.", taxon );
  };

  const updateLocation = useCallback( async (
    location: "worldwide" | "nearby" | ApiPlace,
  ) => {
    if ( location === "worldwide" ) {
      dispatch( { type: EXPLORE_ACTION.SET_PLACE_MODE_WORLDWIDE } );
      dispatch( {
        type: EXPLORE_ACTION.SET_PLACE,
        placeId: null,
      } );
      return;
    }

    if ( location === "nearby" ) {
      const exploreLocation = await defaultExploreLocation( );
      const action = {
        type: EXPLORE_ACTION.SET_EXPLORE_LOCATION,
        exploreLocation,
      };
      dispatch( action );
      setRootStoredParams( exploreReducer( state, action ) );
      return;
    }

    dispatch( { type: EXPLORE_ACTION.SET_PLACE_MODE_PLACE } );
    dispatch( {
      type: EXPLORE_ACTION.SET_PLACE,
      place: location,
      placeId: location?.id,
      placeGuess: location?.display_name,
    } );
  }, [defaultExploreLocation, dispatch, setRootStoredParams, state] );

  const updateUser = ( user: null | { login: string } ) => {
    console.log( "Not implemented in ExploreV2 yet.", user );
  };
  const updateProject = ( project: null | ApiProject ) => {
    console.log( "Not implemented in ExploreV2 yet.", project );
  };

  if ( initialSearchMode === "taxon" ) {
    return (
      <ExploreTaxonSearch
        closeModal={closeModal}
        onPressInfo={( taxon: RealmTaxon | ApiTaxon ) => {
          navigation.push( "TaxonDetails", { id: taxon.id } );
        }}
        updateTaxon={updateTaxon}
      />
    );
  }

  if ( initialSearchMode === "location" ) {
    return (
      <ExploreLocationSearch
        closeModal={closeModal}
        hasPermissions={hasPermissions}
        renderPermissionsGate={renderPermissionsGate}
        requestPermissions={requestPermissions}
        updateLocation={updateLocation}
      />
    );
  }

  if ( initialSearchMode === "users" ) {
    return (
      <ExploreUserSearch closeModal={closeModal} updateUser={updateUser} />
    );
  }

  if ( initialSearchMode === "projects" ) {
    return (
      <ExploreProjectSearch
        closeModal={closeModal}
        updateProject={updateProject}
      />
    );
  }

  return (
    <View>
      {renderPermissionsGate( {} )}
    </View>
  );
};

const ExploreSearchContainer = () => (
  <ExploreProvider>
    <ExploreSearchContainerWithContext />
  </ExploreProvider>
);

export default ExploreSearchContainer;
