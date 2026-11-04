import { useQuery } from "@tanstack/react-query";
import type { EbirdInatObservation, EbirdTaxonFilter } from "api/ebird";
import {
  datesExceedEbirdWindow,
  EBIRD_DATE_PARAMS,
  EBIRD_EXCLUSIVE_PARAMS,
  EBIRD_MAX_DIST_KM,
  EBIRD_MAX_RESULTS,
  EbirdRateLimitError,
  ebirdToInatObservation,
  fetchEbirdObservations,
  isEbirdEnabled,
  resolveEbirdTaxonFilter,
} from "api/ebird";
import fetchPlace from "api/places";
import { useEffect, useMemo } from "react";
import { log } from "sharedHelpers/logger";
import useStore from "stores/useStore";

const logger = log.extend( "useEbirdObservations" );

const STALE_TIME_MS = 24 * 60 * 60 * 1000;
const NO_OBSERVATIONS: EbirdInatObservation[] = [];

export type EbirdLimit = "area" | "dates" | "filters" | "results" | "rate" | "noLocation";

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

const pick = ( params: Record<string, unknown>, keys: string[] ) => Object.fromEntries(
  keys.filter( key => params[key] !== undefined ).map( key => [key, params[key]] ),
);

// eBird sightings matching an Explore search, shaped like iNaturalist
// observations, or null when eBird is off or the filters exclude it
const useEbirdObservations = ( params: Record<string, unknown>, enabled = true ) => {
  const source = useStore( state => state.layout.observationSource );
  const active = enabled && source !== "inaturalist" && isEbirdEnabled( );
  // Only the params that decide which birds eBird results include
  const taxonParams = pick( params, [
    "taxon_id",
    "without_taxon_id",
    "iconic_taxa",
    "quality_grade",
    ...EBIRD_EXCLUSIVE_PARAMS,
  ] );
  const dateParams = pick( params, EBIRD_DATE_PARAMS );
  const { data: taxonFilter, error: taxonFilterError } = useQuery( {
    queryKey: ["ebirdTaxonFilter", taxonParams],
    queryFn: ( ) => resolveEbirdTaxonFilter( taxonParams ),
    enabled: active,
    staleTime: STALE_TIME_MS,
  } );
  const applies = active && !!taxonFilter;

  const placeId = Number( params.place_id ) || null;
  const { data: placeArea } = useQuery( {
    queryKey: ["ebirdPlaceArea", placeId],
    queryFn: ( ) => fetchPlaceArea( placeId as number ),
    enabled: applies && !!placeId,
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

  const lat = area && round( area.lat );
  const lng = area && round( area.lng );
  const distKm = area && Math.min( Math.ceil( area.distKm ), EBIRD_MAX_DIST_KM );
  const { data, error, isLoading } = useQuery( {
    queryKey: ["ebirdObservations", taxonFilter, dateParams, lat, lng, distKm],
    queryFn: ( ) => fetchEbirdObservations( {
      taxonFilter: taxonFilter as EbirdTaxonFilter,
      dateParams,
      lat: lat as number,
      lng: lng as number,
      distKm: distKm as number,
    } ),
    enabled: applies && !!area,
    staleTime: STALE_TIME_MS,
    retry: false,
  } );
  // Either failure otherwise leaves eBird results silently empty
  useEffect( ( ) => {
    if ( taxonFilterError ) {
      logger.warn( "ebird_taxon_filter_error", String( taxonFilterError ) );
    }
  }, [taxonFilterError] );
  useEffect( ( ) => {
    if ( error && !( error instanceof EbirdRateLimitError ) ) {
      logger.warn( "ebird_observations_error", String( error ) );
    }
  }, [error] );

  const observations = useMemo(
    ( ) => ( data
      ? data.map( obs => ebirdToInatObservation( obs ) )
      : NO_OBSERVATIONS ),
    [data],
  );

  // With eBird alone, say why filters it can't match leave nothing
  if ( active && source === "ebird" && taxonFilter === null ) {
    return {
      error: false,
      isLoading: false,
      limits: ["filters"] as EbirdLimit[],
      observations: NO_OBSERVATIONS,
    };
  }
  // With eBird alone, say so when its filters couldn't be worked out
  if ( active && source === "ebird" && taxonFilterError ) {
    return {
      error: true,
      isLoading: false,
      limits: [] as EbirdLimit[],
      observations: NO_OBSERVATIONS,
    };
  }
  if ( !applies ) return null;

  const limits: EbirdLimit[] = [];
  if ( !placeId && !area ) limits.push( "noLocation" );
  if ( area && area.distKm > EBIRD_MAX_DIST_KM ) limits.push( "area" );
  if ( datesExceedEbirdWindow( dateParams ) ) limits.push( "dates" );
  if ( observations.length >= EBIRD_MAX_RESULTS ) limits.push( "results" );
  if ( error instanceof EbirdRateLimitError ) limits.push( "rate" );

  return {
    error: error && !( error instanceof EbirdRateLimitError ),
    isLoading,
    limits,
    observations,
  };
};

export default useEbirdObservations;
