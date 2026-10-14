import { useQuery } from "@tanstack/react-query";
import {
  EBIRD_MAX_DIST_KM,
  EBIRD_MAX_RESULTS,
  EbirdRateLimitError,
  fetchEbirdObservations,
  isEbirdEnabled,
} from "api/ebird";
import fetchPlace from "api/places";
import { useTaxon } from "sharedHooks";

const AVES_ID = 3;
const STALE_TIME_MS = 15 * 60 * 1000;
const DATE_PARAMS = ["d1", "d2", "observed_on", "month", "year", "created_d1", "created_d2"];
// eBird results can't be filtered by these, so skip eBird rather than show
// results that ignore them
const EXCLUSIVE_PARAMS = ["user_id", "project_id", "ident_user_id"];

export type EbirdLimit = "area" | "dates" | "results" | "rate" | "noLocation";

interface Area { lat: number; lng: number; distKm: number }

const distanceKm = ( lat1: number, lng1: number, lat2: number, lng2: number ) => {
  const rad = ( deg: number ) => ( deg * Math.PI ) / 180;
  const a = Math.sin( rad( lat2 - lat1 ) / 2 ) ** 2
    + Math.cos( rad( lat1 ) ) * Math.cos( rad( lat2 ) ) * Math.sin( rad( lng2 - lng1 ) / 2 ) ** 2;
  return 12742 * Math.asin( Math.sqrt( a ) );
};

const boundsToArea = ( swlat: number, swlng: number, nelat: number, nelng: number ): Area => {
  const lat = ( swlat + nelat ) / 2;
  const lng = ( swlng + nelng ) / 2;
  return { lat, lng, distKm: distanceKm( lat, lng, nelat, nelng ) };
};

const fetchPlaceArea = async ( placeId: number ): Promise<Area | null> => {
  const place = await fetchPlace( placeId, {
    fields: { location: true, bounding_box_geojson: true },
  } );
  const ring: number[][] | undefined = place?.bounding_box_geojson?.coordinates?.[0];
  if ( !ring ) return null;
  const lngs = ring.map( ( [lng] ) => lng );
  const lats = ring.map( ( [, lat] ) => lat );
  return boundsToArea(
    Math.min( ...lats ),
    Math.min( ...lngs ),
    Math.max( ...lats ),
    Math.max( ...lngs ),
  );
};

// Round so small map moves reuse cached eBird results instead of refetching
const round = ( n: number ) => Math.round( n * 100 ) / 100;

const useEbirdObservations = ( params: Record<string, unknown>, enabled = true ) => {
  const taxonId = Number( params.taxon_id );
  const { taxon } = useTaxon( { id: taxonId }, !!taxonId );
  const isBirdSpecies = taxon?.rank === "species"
    && Array.from( taxon?.ancestor_ids || [] ).includes( AVES_ID );
  const isAllBirds = taxonId === AVES_ID;
  const applies = isEbirdEnabled( )
    && ( isBirdSpecies || isAllBirds )
    && !EXCLUSIVE_PARAMS.some( key => params[key] );

  const placeId = Number( params.place_id ) || null;
  const { data: placeArea } = useQuery( {
    queryKey: ["ebirdPlaceArea", placeId],
    queryFn: ( ) => fetchPlaceArea( placeId as number ),
    enabled: enabled && applies && !!placeId,
    staleTime: Infinity,
  } );

  let area: Area | null | undefined;
  if ( typeof params.lat === "number" && typeof params.lng === "number" ) {
    area = { lat: params.lat, lng: params.lng, distKm: Number( params.radius ) || 1 };
  } else if ( typeof params.swlat === "number" ) {
    area = boundsToArea(
      params.swlat,
      params.swlng as number,
      params.nelat as number,
      params.nelng as number,
    );
  } else if ( placeId ) {
    area = placeArea;
  }

  const sciName = isAllBirds
    ? undefined
    : taxon?.name;
  const lat = area && round( area.lat );
  const lng = area && round( area.lng );
  const distKm = area && Math.min( Math.ceil( area.distKm ), EBIRD_MAX_DIST_KM );
  const { data: observations, error, isLoading } = useQuery( {
    queryKey: ["ebirdObservations", sciName, lat, lng, distKm],
    queryFn: ( ) => fetchEbirdObservations( {
      sciName,
      lat: lat as number,
      lng: lng as number,
      distKm: distKm as number,
    } ),
    enabled: enabled && applies && !!area,
    staleTime: STALE_TIME_MS,
    retry: false,
  } );

  if ( !applies ) return null;

  const limits: EbirdLimit[] = [];
  if ( !placeId && !area ) limits.push( "noLocation" );
  if ( area && area.distKm > EBIRD_MAX_DIST_KM ) limits.push( "area" );
  if ( DATE_PARAMS.some( key => params[key] ) ) limits.push( "dates" );
  if ( ( observations?.length || 0 ) >= EBIRD_MAX_RESULTS ) limits.push( "results" );
  if ( error instanceof EbirdRateLimitError ) limits.push( "rate" );

  return {
    error: error && !( error instanceof EbirdRateLimitError ),
    isLoading,
    limits,
    observations: observations || [],
  };
};

export default useEbirdObservations;
