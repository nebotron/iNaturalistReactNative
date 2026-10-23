import type { ApiProjectSummary, ApiTotalBounds, ApiUser } from "api/types";
import type {
  HOTSPOTS_TAB, IDENTIFICATIONS_TAB, IDENTIFIERS_TAB, IDENTIFY_TAB, LIFELIST_TAB,
  OBSERVERS_TAB, SPECIES_TAB,
} from "appConstants/tabs";
import { OBSERVATIONS_TAB } from "appConstants/tabs";
import type { ExploreTaxonFilter } from "components/Explore/helpers/taxonFilters";
import type { ExploreV2EntryParams } from "navigation/types";
import type { EVIDENCE_TYPE, TAXONOMIC_RANK } from "providers/ExploreContext";
import {
  DATE_OBSERVED,
  DATE_UPLOADED,
  ESTABLISHMENT_MEAN,
  MEDIA,
  PHOTO_LICENSE,
  REVIEWED,
  WILD_STATUS,
} from "providers/ExploreContext";
import * as React from "react";
import { OBSERVATIONS_SORT } from "sharedHelpers/observationsSort";
import { SPECIES_SORT } from "sharedHelpers/speciesSort";

export enum EXPLORE_V2_ACTION {
  SET_SUBJECT = "SET_SUBJECT",
  CLEAR_SUBJECT = "CLEAR_SUBJECT",
  SET_LOCATION_NEARBY = "SET_LOCATION_NEARBY",
  SET_LOCATION_WORLDWIDE = "SET_LOCATION_WORLDWIDE",
  SET_LOCATION_PLACE = "SET_LOCATION_PLACE",
  SET_LOCATION_MAP_AREA = "SET_LOCATION_MAP_AREA",
  SET_SORT = "SET_SORT",
  SET_SPECIES_SORT = "SET_SPECIES_SORT",
  SET_FILTERS = "SET_FILTERS",
  SET_ACTIVE_TAB = "SET_ACTIVE_TAB",
  APPLY_SEARCH = "APPLY_SEARCH",
  SEARCH_SPECIES = "SEARCH_SPECIES",
  GO_BACK = "GO_BACK",
  RESET = "RESET"
}

export enum EXPLORE_V2_PLACE_MODE {
  NEARBY = "NEARBY",
  WORLDWIDE = "WORLDWIDE",
  PLACE = "PLACE",
  MAP_AREA = "MAP_AREA"
}

export interface Place {
  id: number;
  display_name?: string;
  place_type?: number | null;
}

interface Taxon {
  id: number;
  name: string;
  preferred_common_name?: string;
  default_photo?: { url?: string };
  iconic_taxon_name?: string;
  rank_level?: number;
}

interface User {
  id: number;
  login: string;
  icon_url?: string;
  observations_count?: number;
}

export type ExploreV2Tab =
  | typeof OBSERVATIONS_TAB
  | typeof SPECIES_TAB
  | typeof OBSERVERS_TAB
  | typeof IDENTIFIERS_TAB
  | typeof HOTSPOTS_TAB
  | typeof LIFELIST_TAB
  | typeof IDENTIFY_TAB
  | typeof IDENTIFICATIONS_TAB;

export type ExploreV2Subject =
  | { type: "taxon"; taxon: Taxon }
  | { type: "user"; user: User }
  | { type: "project"; project: ApiProjectSummary }
  | { type: "unobserved"; user: User }
  | { type: "unknown" };

export interface ExploreV2Filters {
  // Quality grade
  researchGrade: boolean;
  needsID: boolean;
  casual: boolean;
  // Taxonomic ranks
  hrank?: TAXONOMIC_RANK | null;
  lrank?: TAXONOMIC_RANK | null;
  // Date observed
  dateObserved: DATE_OBSERVED;
  observed_on?: string | null;
  d1?: string | null;
  d2?: string | null;
  months?: number[] | null;
  // Date uploaded
  dateUploaded: DATE_UPLOADED;
  created_on?: string | null;
  created_d1?: string | null;
  created_d2?: string | null;
  // Single-select filters
  media: MEDIA;
  establishmentMean: ESTABLISHMENT_MEAN;
  wildStatus: WILD_STATUS;
  reviewedFilter: REVIEWED;
  photoLicense: PHOTO_LICENSE;
  evidenceTypes?: EVIDENCE_TYPE[] | null;
  // At least one fave
  popular?: boolean | null;
  // User / project, in ExploreV2 parlance we always consider taxon to be the "subject"
  user?: ApiUser | null;
  unobservedByUser?: ApiUser | null;
  project?: ApiProjectSummary | null;
  // Taxa searched for beyond the subject taxon, and excluded taxa
  taxonFilters?: ExploreTaxonFilter[] | null;
}

export const defaultExploreV2Filters: ExploreV2Filters = {
  researchGrade: true,
  needsID: true,
  casual: false,
  hrank: null,
  lrank: null,
  dateObserved: DATE_OBSERVED.ALL,
  dateUploaded: DATE_UPLOADED.ALL,
  media: MEDIA.ALL,
  establishmentMean: ESTABLISHMENT_MEAN.ANY,
  wildStatus: WILD_STATUS.ALL,
  reviewedFilter: REVIEWED.ALL,
  photoLicense: PHOTO_LICENSE.ALL,
};

export type ExploreV2LocationState =
  | { placeMode: EXPLORE_V2_PLACE_MODE.WORLDWIDE }
  | { placeMode: EXPLORE_V2_PLACE_MODE.NEARBY; radius?: number }
  | { placeMode: EXPLORE_V2_PLACE_MODE.PLACE; place: Place }
  | { placeMode: EXPLORE_V2_PLACE_MODE.MAP_AREA; bounds: ApiTotalBounds };

export interface ExploreV2State {
  subject: ExploreV2Subject | null;
  location: ExploreV2LocationState;
  sortBy: OBSERVATIONS_SORT;
  speciesSortBy: SPECIES_SORT;
  filters: ExploreV2Filters;
  activeTab: ExploreV2Tab;
  // Bumped each time a whole search is applied from outside the results screen, e.g. a
  // saved search. Lets a view tell "the search moved out from under me" apart from
  // "the same search re-rendered", which the search fields alone can't when they're equal.
  appliedSearchCount: number;
  // Subjects and tabs to return to, pushed when a species card opens a search for it
  backStack: { subject: ExploreV2Subject | null; activeTab: ExploreV2Tab }[];
}

// Everything that defines a search, as opposed to how the results are being viewed
export type ExploreV2Search = Omit<
  ExploreV2State,
  "activeTab" | "appliedSearchCount" | "backStack"
>;

// A saved search also remembers the view it was saved from: the tab and the observations
// map/grid/list layout. Optional because searches saved before views were recorded don't
// have one.
export type ExploreV2SearchWithTab = ExploreV2Search & {
  activeTab?: ExploreV2Tab;
  observationsLayout?: string;
};

export type ExploreV2Action =
  | { type: EXPLORE_V2_ACTION.SET_SUBJECT; subject: ExploreV2Subject }
  | { type: EXPLORE_V2_ACTION.CLEAR_SUBJECT }
  | { type: EXPLORE_V2_ACTION.SET_LOCATION_NEARBY; radius?: number }
  | { type: EXPLORE_V2_ACTION.SET_LOCATION_WORLDWIDE }
  | {
    type: EXPLORE_V2_ACTION.SET_LOCATION_PLACE;
    place: Place;
  }
  | {
    type: EXPLORE_V2_ACTION.SET_LOCATION_MAP_AREA;
    bounds: ApiTotalBounds;
  }
  | { type: EXPLORE_V2_ACTION.SET_SORT; sortBy: OBSERVATIONS_SORT }
  | { type: EXPLORE_V2_ACTION.SET_SPECIES_SORT; speciesSortBy: SPECIES_SORT }
  | { type: EXPLORE_V2_ACTION.SET_FILTERS; filters: ExploreV2Filters }
  | { type: EXPLORE_V2_ACTION.SET_ACTIVE_TAB; tab: ExploreV2Tab }
  | { type: EXPLORE_V2_ACTION.APPLY_SEARCH; search: ExploreV2SearchWithTab }
  | { type: EXPLORE_V2_ACTION.SEARCH_SPECIES; subject: ExploreV2Subject }
  | { type: EXPLORE_V2_ACTION.GO_BACK }
  | { type: EXPLORE_V2_ACTION.RESET };

export const initialExploreV2State: ExploreV2State = {
  subject: null,
  location: { placeMode: EXPLORE_V2_PLACE_MODE.NEARBY },
  sortBy: OBSERVATIONS_SORT.DATE_UPLOADED_NEWEST,
  speciesSortBy: SPECIES_SORT.COUNT_DESC,
  filters: defaultExploreV2Filters,
  activeTab: OBSERVATIONS_TAB,
  appliedSearchCount: 0,
  backStack: [],
};

export function initialStateFromEntryParams(
  params?: ExploreV2EntryParams | null,
): ExploreV2State {
  return {
    ...initialExploreV2State,
    subject: params?.subject || initialExploreV2State.subject,
    location: params?.location || initialExploreV2State.location,
    activeTab: params?.activeTab || initialExploreV2State.activeTab,
    filters: { ...initialExploreV2State.filters, ...params?.filters },
    sortBy: params?.sortBy || initialExploreV2State.sortBy,
  };
}

export function exploreV2Reducer(
  state: ExploreV2State,
  action: ExploreV2Action,
): ExploreV2State {
  switch ( action.type ) {
    case EXPLORE_V2_ACTION.SET_SUBJECT:
      return { ...state, subject: action.subject, backStack: [] };
    case EXPLORE_V2_ACTION.CLEAR_SUBJECT:
      return { ...state, subject: null, backStack: [] };
    case EXPLORE_V2_ACTION.SET_LOCATION_NEARBY:
      return {
        ...state,
        location: { placeMode: EXPLORE_V2_PLACE_MODE.NEARBY, radius: action.radius },
      };
    case EXPLORE_V2_ACTION.SET_LOCATION_WORLDWIDE:
      return {
        ...state,
        location: { placeMode: EXPLORE_V2_PLACE_MODE.WORLDWIDE },
      };
    case EXPLORE_V2_ACTION.SET_LOCATION_PLACE:
      return {
        ...state,
        location: {
          placeMode: EXPLORE_V2_PLACE_MODE.PLACE,
          place: action.place,
        },
      };
    case EXPLORE_V2_ACTION.SET_LOCATION_MAP_AREA:
      return {
        ...state,
        location: {
          placeMode: EXPLORE_V2_PLACE_MODE.MAP_AREA,
          bounds: action.bounds,
        },
      };
    case EXPLORE_V2_ACTION.SET_SORT:
      return { ...state, sortBy: action.sortBy };
    case EXPLORE_V2_ACTION.SET_SPECIES_SORT:
      return { ...state, speciesSortBy: action.speciesSortBy };
    case EXPLORE_V2_ACTION.SET_FILTERS:
      return { ...state, filters: action.filters };
    case EXPLORE_V2_ACTION.SET_ACTIVE_TAB:
      return { ...state, activeTab: action.tab };
    case EXPLORE_V2_ACTION.APPLY_SEARCH: {
      const {
        subject, location, sortBy, speciesSortBy, filters,
      } = action.search;
      return {
        ...state,
        subject,
        location,
        sortBy,
        speciesSortBy,
        filters,
        activeTab: action.search.activeTab ?? state.activeTab,
        appliedSearchCount: state.appliedSearchCount + 1,
        backStack: [],
      };
    }
    case EXPLORE_V2_ACTION.SEARCH_SPECIES:
      return {
        ...state,
        subject: action.subject,
        activeTab: OBSERVATIONS_TAB,
        backStack: [
          ...state.backStack,
          { subject: state.subject, activeTab: state.activeTab },
        ],
      };
    case EXPLORE_V2_ACTION.GO_BACK: {
      const previous = state.backStack[state.backStack.length - 1];
      if ( !previous ) return state;
      return {
        ...state,
        subject: previous.subject,
        activeTab: previous.activeTab,
        backStack: state.backStack.slice( 0, -1 ),
      };
    }
    case EXPLORE_V2_ACTION.RESET:
      return initialExploreV2State;
    default: {
      // https://www.typescriptlang.org/docs/handbook/2/narrowing.html#exhaustiveness-checking
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

interface ExploreV2ContextValue {
  state: ExploreV2State;
  dispatch: ( action: ExploreV2Action ) => void;
}

const ExploreV2Context = React.createContext<ExploreV2ContextValue | undefined>(
  undefined,
);

interface ExploreV2ProviderProps {
  children: React.ReactNode;
  initialState: ExploreV2State;
}

export const ExploreV2Provider = ( { children, initialState }: ExploreV2ProviderProps ) => {
  const [state, dispatch] = React.useReducer( exploreV2Reducer, initialState );

  const value = React.useMemo(
    () => ( { state, dispatch } ),
    [state],
  );

  return (
    <ExploreV2Context value={value}>
      {children}
    </ExploreV2Context>
  );
};

export function useExploreV2( ): ExploreV2ContextValue {
  const context = React.useContext( ExploreV2Context );
  // Pattern from https://kentcdodds.com/blog/how-to-use-react-context-effectively
  if ( context === undefined ) {
    throw new Error( "useExploreV2 must be used within an ExploreV2Provider" );
  }
  return context;
}
