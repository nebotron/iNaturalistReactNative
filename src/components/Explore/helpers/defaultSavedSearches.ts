import { OBSERVATIONS_TAB, SPECIES_TAB } from "appConstants/tabs";
import type { ExploreV2SearchWithTab } from "providers/ExploreContext";
import {
  defaultExploreFilters, EXPLORE_PLACE_MODE, initialExploreState,
} from "providers/ExploreContext";
import type { SavedSearchInput } from "stores/createExploreSearchesSlice";

interface DefaultSearchUser {
  id: number;
  login: string;
  icon_url?: string;
}

type T = ( _key: string ) => string;

const UNOBSERVED_NEARBY_RADIUS_KM = 10;

const baseSearch: ExploreV2SearchWithTab = {
  subject: null,
  location: initialExploreState.location,
  sortBy: initialExploreState.sortBy,
  speciesSortBy: initialExploreState.speciesSortBy,
  filters: defaultExploreFilters,
};

// The saved searches a user starts with:
//  - My species: every species they've observed, of any quality grade
//  - Unobserved by me: observations nearby, on the map, of species not in My species
const defaultSavedSearches = ( user: DefaultSearchUser, t: T ): SavedSearchInput[] => {
  const mySpeciesName = t( "My-species" );
  const { id, login, icon_url: iconUrl } = user;
  return [
    {
      ...baseSearch,
      key: `default-my-species-${id}`,
      name: mySpeciesName,
      subject: { type: "user", user: { id, login, icon_url: iconUrl } },
      location: { placeMode: EXPLORE_PLACE_MODE.WORLDWIDE },
      filters: { ...defaultExploreFilters, casual: true },
      activeTab: SPECIES_TAB,
    },
    {
      ...baseSearch,
      key: `default-unobserved-by-me-${id}`,
      name: t( "Unobserved-by-me" ),
      location: {
        placeMode: EXPLORE_PLACE_MODE.NEARBY,
        radius: UNOBSERVED_NEARBY_RADIUS_KM,
      },
      filters: { ...defaultExploreFilters, excludeSpeciesInSavedSearch: mySpeciesName },
      activeTab: OBSERVATIONS_TAB,
      observationsLayout: "map",
    },
  ];
};

export default defaultSavedSearches;
