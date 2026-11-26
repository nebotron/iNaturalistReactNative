import { searchTaxonFilters } from "components/Explore/helpers/advancedSearchReducer";
import { taxonFiltersToApiParams } from "components/Explore/helpers/taxonFilters";
import withoutObservedSpecies from "components/Explore/helpers/withoutObservedSpecies";
import type { ExploreState } from "providers/ExploreContext";
import {
  EXPLORE_PLACE_MODE,
} from "providers/ExploreContext";
import { DEFAULT_EXPLORE_V2_NEARBY_RADIUS_KM } from "sharedHelpers/nearbyRadius";
import { observationSortToApiParams } from "sharedHelpers/observationsSort";
import type { ObservationOrderBy, SortDirection } from "types/sorting";

import type { FilterApiParams } from "./filtersToApiParams";
import filtersToApiParams from "./filtersToApiParams";

const PER_PAGE = 20;

export interface ExploreQueryParams extends FilterApiParams {
  per_page: number;
  order_by: ObservationOrderBy;
  order: SortDirection;
  taxon_id?: number | string;
  without_taxon_id?: number | string;
  iconic_taxa?: string[];
  lat?: number;
  lng?: number;
  radius?: number;
  place_id?: number;
  swlat?: number;
  swlng?: number;
  nelat?: number;
  nelng?: number;
  verifiable?: boolean;
  identified?: boolean;
}

// sans the paging and sorting params that only apply to the observations search
export type ExploreBaseQueryParams = Omit<
  ExploreQueryParams,
  "order_by" | "order" | "per_page"
>;

export interface NearbyCoords {
  lat: number;
  lng: number;
}

// Metres in a degree of latitude, and in a degree of longitude at the equator
const METERS_PER_DEGREE = 111320;
const NEARBY_GRID_METERS = 100;

// The location snapped to a 100 m grid, so a Nearby search from about the same
// spot makes the same query and finds results saved from before, offline too.
// Each latitude band has its own longitude step, so the grid stays 100 m wide.
export const roundNearbyCoords = ( { lat, lng }: NearbyCoords ): NearbyCoords => {
  const latStep = NEARBY_GRID_METERS / METERS_PER_DEGREE;
  const roundedLat = Math.round( lat / latStep ) * latStep;
  // Near the poles a degree of longitude shrinks to nothing
  const cosLat = Math.max( Math.cos( roundedLat * ( Math.PI / 180 ) ), 0.01 );
  const lngStep = latStep / cosLat;
  const roundedLng = Math.round( lng / lngStep ) * lngStep;
  // Fixed decimals, so the same cell always gives the same query key
  return {
    lat: Number( roundedLat.toFixed( 6 ) ),
    lng: Number( Math.max( -180, Math.min( 180, roundedLng ) ).toFixed( 6 ) ),
  };
};

// Whether the search leaves out the species a saved search finds. See excludedSpecies.
export const excludesSpecies = ( state: Pick<ExploreState, "filters"> ): boolean => (
  !!state.filters.excludeSpeciesInSavedSearch
);

const buildExploreQueryParams = (
  state: ExploreState,
  nearbyCoords?: NearbyCoords,
  // The signed-in user's id, needed by the reviewed filter (viewer_id param).
  currentUserId?: number | null,
  // Species the search leaves out (see excludesSpecies and excludedSpecies),
  // freshly resolved. Callers mustn't fetch while excludesSpecies is true until
  // they have these.
  excludedSpeciesIds?: number[],
): ExploreQueryParams => {
  const params: ExploreQueryParams = {
    per_page: PER_PAGE,
    verifiable: true,
    ...observationSortToApiParams( state.sortBy ),
  };

  Object.assign( params, taxonFiltersToApiParams(
    searchTaxonFilters( state.subject, state.filters ),
  ) );

  // this might warrant moving into a selector function at some point
  switch ( state.subject?.type ) {
    case "user":
      params.user_id = state.subject.user.id;
      break;
    case "project":
      params.project_id = state.subject.project.id;
      break;
    case "unobserved":
      params.unobserved_by_user_id = state.subject.user.id;
      break;
    case "unknown":
      params.iconic_taxa = ["unknown"];
      params.identified = false;
      break;
    default:
      break;
  }

  const { location } = state;
  switch ( location.placeMode ) {
    case EXPLORE_PLACE_MODE.NEARBY:
      if ( nearbyCoords ) {
        const { lat, lng } = roundNearbyCoords( nearbyCoords );
        params.lat = lat;
        params.lng = lng;
        params.radius = location.radius ?? DEFAULT_EXPLORE_V2_NEARBY_RADIUS_KM;
      }
      break;
    case EXPLORE_PLACE_MODE.PLACE:
      params.place_id = location.place.id;
      break;
    case EXPLORE_PLACE_MODE.MAP_AREA:
      params.swlat = location.bounds.swlat;
      params.swlng = location.bounds.swlng;
      params.nelat = location.bounds.nelat;
      params.nelng = location.bounds.nelng;
      break;
    case EXPLORE_PLACE_MODE.WORLDWIDE:
      break;
    default: {
      // Exhaustiveness check: ts fails if a new placeMode is added without a case.
      const _exhaustive: never = location;
      return _exhaustive;
    }
  }

  // Advanced Search filters
  const filterParams = filtersToApiParams( state.filters, currentUserId );
  const paramsWithFilters: ExploreQueryParams = {
    ...params,
    ...filterParams,
  };

  // `verifiable: true` excludes casual-grade observations
  // so drop it when the user explicitly asked for captive/casual
  if ( paramsWithFilters.quality_grade?.includes( "casual" ) || paramsWithFilters.captive ) {
    delete paramsWithFilters.verifiable;
  }

  // Applied as a list of species; see excludedSpecies
  if ( excludesSpecies( state ) ) {
    const withoutTaxonId = withoutObservedSpecies(
      paramsWithFilters.without_taxon_id,
      excludedSpeciesIds ?? [],
    );
    if ( withoutTaxonId !== undefined ) paramsWithFilters.without_taxon_id = withoutTaxonId;
  }

  return paramsWithFilters;
};

export default buildExploreQueryParams;
