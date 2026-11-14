import { OBSERVATIONS_TAB, SPECIES_TAB } from "appConstants/tabs";
import type { ExploreV2SearchWithTab } from "providers/ExploreV2Context";
import {
  defaultExploreV2Filters, EXPLORE_V2_PLACE_MODE, initialExploreV2State,
} from "providers/ExploreV2Context";
import type { SavedSearchInput } from "stores/createExploreV2SearchesSlice";

interface DefaultSearchUser {
  id: number;
  login: string;
  icon_url?: string;
}

type T = ( _key: string ) => string;

const UNOBSERVED_NEARBY_RADIUS_KM = 10;

const baseSearch: ExploreV2SearchWithTab = {
  subject: null,
  location: initialExploreV2State.location,
  sortBy: initialExploreV2State.sortBy,
  speciesSortBy: initialExploreV2State.speciesSortBy,
  filters: defaultExploreV2Filters,
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
      location: { placeMode: EXPLORE_V2_PLACE_MODE.WORLDWIDE },
      filters: { ...defaultExploreV2Filters, casual: true },
      activeTab: SPECIES_TAB,
    },
    {
      ...baseSearch,
      key: `default-unobserved-by-me-${id}`,
      name: t( "Unobserved-by-me" ),
      location: {
        placeMode: EXPLORE_V2_PLACE_MODE.NEARBY,
        radius: UNOBSERVED_NEARBY_RADIUS_KM,
      },
      filters: { ...defaultExploreV2Filters, excludeSpeciesInSavedSearch: mySpeciesName },
      activeTab: OBSERVATIONS_TAB,
      observationsLayout: "map",
    },
  ];
};

export default defaultSavedSearches;
