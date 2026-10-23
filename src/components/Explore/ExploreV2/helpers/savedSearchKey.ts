import type {
  ExploreV2Filters, ExploreV2LocationState, ExploreV2SearchWithTab,
} from "providers/ExploreV2Context";
import { EXPLORE_V2_PLACE_MODE } from "providers/ExploreV2Context";
import { DEFAULT_EXPLORE_V2_NEARBY_RADIUS_KM } from "sharedHelpers/nearbyRadius";
import { subjectKey } from "stores/createExploreV2SearchesSlice";

export type SavedSearchIdentity = ExploreV2SearchWithTab;

const locationKey = ( location: ExploreV2LocationState ): string => {
  switch ( location.placeMode ) {
    case EXPLORE_V2_PLACE_MODE.WORLDWIDE:
      return "worldwide";
    case EXPLORE_V2_PLACE_MODE.NEARBY:
      // Default radius keeps the key that searches saved before radii existed have
      return !location.radius || location.radius === DEFAULT_EXPLORE_V2_NEARBY_RADIUS_KM
        ? "nearby"
        : `nearby-${location.radius}`;
    case EXPLORE_V2_PLACE_MODE.PLACE:
      return `place-${location.place.id}`;
    case EXPLORE_V2_PLACE_MODE.MAP_AREA: {
      const {
        swlat, swlng, nelat, nelng,
      } = location.bounds;
      // Rounded so an imperceptible pan doesn't read as a different search
      const corners = [swlat, swlng, nelat, nelng].map( corner => corner.toFixed( 4 ) );
      return `bounds-${corners.join( "," )}`;
    }
    default: {
      const _exhaustive: never = location;
      return _exhaustive;
    }
  }
};

// Typed as a Record of every ExploreV2Filters field, so tsc fails if a new filter is added
// without a value here. A missing field would silently collide two different searches, and
// one would unsave the other. Keys are sorted rather than taken in literal order so the key
// can't shift under us the way Object.keys or JSON.stringify can.
const filtersKey = ( filters: ExploreV2Filters ): string => {
  const parts: Record<keyof ExploreV2Filters, string> = {
    researchGrade: String( filters.researchGrade ),
    needsID: String( filters.needsID ),
    casual: String( filters.casual ),
    hrank: filters.hrank ?? "",
    lrank: filters.lrank ?? "",
    dateObserved: filters.dateObserved,
    observed_on: filters.observed_on ?? "",
    d1: filters.d1 ?? "",
    d2: filters.d2 ?? "",
    months: [...( filters.months ?? [] )].sort( ( a, b ) => a - b ).join( "," ),
    dateUploaded: filters.dateUploaded,
    created_on: filters.created_on ?? "",
    created_d1: filters.created_d1 ?? "",
    created_d2: filters.created_d2 ?? "",
    media: filters.media,
    establishmentMean: filters.establishmentMean,
    wildStatus: filters.wildStatus,
    reviewedFilter: filters.reviewedFilter,
    photoLicense: filters.photoLicense,
    evidenceTypes: [...( filters.evidenceTypes ?? [] )].sort( ).join( "," ),
    popular: filters.popular
      ? "true"
      : "",
    user: String( filters.user?.id ?? "" ),
    unobservedByUser: String( filters.unobservedByUser?.id ?? "" ),
    project: String( filters.project?.id ?? "" ),
    taxonFilters: ( filters.taxonFilters || [] )
      .map( filter => `${filter.exclude
        ? "-"
        : ""}${filter.taxon.id}` )
      .join( "," ),
  };

  return ( Object.keys( parts ) as ( keyof ExploreV2Filters )[] )
    .sort( )
    .map( field => `${field}=${parts[field]}` )
    .join( ";" );
};

const savedSearchKey = ( search: SavedSearchIdentity ): string => {
  const parts: Record<keyof SavedSearchIdentity, string> = {
    subject: search.subject
      ? subjectKey( search.subject )
      : "none",
    location: locationKey( search.location ),
    sortBy: search.sortBy,
    speciesSortBy: search.speciesSortBy,
    filters: filtersKey( search.filters ),
    activeTab: search.activeTab ?? "",
    observationsLayout: search.observationsLayout ?? "",
    gridOverlays: search.gridOverlays
      ? Object.entries( search.gridOverlays )
        .filter( ( [, shown] ) => shown )
        .map( ( [overlay] ) => overlay )
        .sort( )
        .join( "," )
      : "",
  };

  return ( Object.keys( parts ) as ( keyof SavedSearchIdentity )[] )
    .sort( )
    .map( field => `${field}=${parts[field]}` )
    .join( "|" );
};

export default savedSearchKey;
