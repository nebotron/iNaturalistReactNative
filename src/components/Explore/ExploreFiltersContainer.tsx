import { useNavigation } from "@react-navigation/native";
import type { ApiProject } from "api/types";
import type { ExploreTaxonFilter } from "components/Explore/helpers/taxonFilters";
import {
  EXPLORE_ACTION,
  ExploreProvider,
  useExplore,
} from "providers/ExploreContext";
import React from "react";

import FilterModalV2 from "./Modals/FilterModalV2";

const ExploreFiltersContainerWithContext = () => {
  const navigation = useNavigation();
  const { dispatch } = useExplore();

  const closeModal = () => {
    navigation.goBack();
  };

  const filterByIconicTaxonUnknown = () => {
    dispatch( { type: EXPLORE_ACTION.FILTER_BY_ICONIC_TAXON_UNKNOWN } );
  };

  const updateTaxonFilters = ( taxonFilters: ExploreTaxonFilter[] ) => {
    dispatch( {
      type: EXPLORE_ACTION.SET_TAXON_FILTERS,
      taxonFilters,
    } );
  };

  const updateUser = (
    user: {
      login: string;
    } | null,
  ) => {
    console.log( " Not implemented in ExploreV2 yet", user );
  };

  const updateProject = ( project: ApiProject ) => {
    console.log( " Not implemented in ExploreV2 yet", project );
  };

  return (
    <FilterModalV2
      closeModal={closeModal}
      filterByIconicTaxonUnknown={filterByIconicTaxonUnknown}
      updateTaxonFilters={updateTaxonFilters}
      updateUser={updateUser}
      updateProject={updateProject}
    />
  );
};

const ExploreFiltersContainer = () => (
  <ExploreProvider>
    <ExploreFiltersContainerWithContext />
  </ExploreProvider>
);

export default ExploreFiltersContainer;
