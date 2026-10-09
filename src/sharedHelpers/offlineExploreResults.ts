import { prefetch } from "@candlefinance/faster-image";
import {
  DocumentDirectoryPath,
  exists,
  readFile,
  unlink,
  writeFile,
} from "@dr.pogodin/react-native-fs";
import { searchObservations } from "api/observations";
import type { ApiObservation } from "api/types";
import {
  addPageParamsForExplore,
  getNextPageParamForExplore,
} from "components/Explore/helpers/exploreParams";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import Observation from "realmModels/Observation";
import ObservationSound from "realmModels/ObservationSound";
import Photo from "realmModels/Photo";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "offlineExploreResults" );

// One saved Explore search, kept on disk so its results can be browsed and
// filtered further with no connection.
const FILE_PATH = `${DocumentDirectoryPath}/offlineExploreResults.json`;
const PAGE_SIZE = 200;
export const MAX_OFFLINE_OBSERVATIONS = 2000;

type Params = Record<string, unknown>;

export interface OfflineExploreResults {
  savedAt: string;
  params: Params;
  observations: ApiObservation[];
}

let cached: OfflineExploreResults | null | undefined;
const listeners = new Set<( ) => void>( );
const notify = ( ) => listeners.forEach( l => l( ) );

export const subscribeOfflineExploreResults = ( listener: ( ) => void ) => {
  listeners.add( listener );
  return ( ) => { listeners.delete( listener ); };
};

export const getCachedOfflineExploreResults = ( ) => cached;

export const loadOfflineExploreResults = async ( ) => {
  if ( cached !== undefined ) return cached;
  try {
    cached = await exists( FILE_PATH )
      ? JSON.parse( await readFile( FILE_PATH, "utf8" ) )
      : null;
  } catch ( e ) {
    logger.error( "Failed to read offline explore results", e );
    cached = null;
  }
  notify( );
  return cached;
};

export const deleteOfflineExploreResults = async ( ) => {
  cached = null;
  notify( );
  if ( await exists( FILE_PATH ) ) await unlink( FILE_PATH );
};

const FIELDS = {
  ...Observation.ADVANCED_MODE_LIST_FIELDS,
  captive: true,
  geojson: true,
  observation_sounds: ObservationSound.OBSERVATION_SOUNDS_FIELDS,
  taxon: {
    ...Observation.ADVANCED_MODE_LIST_FIELDS.taxon,
    // Needed to filter by taxon offline
    ancestor_ids: true,
    iconic_taxon_name: true,
  },
  user: {
    id: true,
    uuid: true,
    login: true,
  },
};

export const downloadOfflineExploreResults = async (
  queryParams: Params,
  onProgress?: ( count: number ) => void,
) => {
  const baseParams = {
    ...queryParams,
    per_page: PAGE_SIZE,
    fields: FIELDS,
    ttl: -1,
  };
  const apiToken = await getJWT( true );
  const observations: ApiObservation[] = [];
  const seen = new Set<string>( );
  let pageParam: unknown;
  while ( observations.length < MAX_OFFLINE_OBSERVATIONS ) {
    // eslint-disable-next-line no-await-in-loop
    const response = await searchObservations(
      addPageParamsForExplore( { ...baseParams, pageParam } ),
      { api_token: apiToken },
    );
    if ( !response?.results?.length ) break;
    response.results.forEach( ( obs: ApiObservation ) => {
      if ( obs.uuid && !seen.has( obs.uuid ) ) {
        seen.add( obs.uuid );
        observations.push( obs );
      }
    } );
    onProgress?.( observations.length );
    pageParam = getNextPageParamForExplore( response, baseParams );
    if ( pageParam == null || response.results.length < PAGE_SIZE ) break;
  }
  const results: OfflineExploreResults = {
    savedAt: new Date( ).toISOString( ),
    params: queryParams,
    observations: observations.slice( 0, MAX_OFFLINE_OBSERVATIONS ),
  };
  await writeFile( FILE_PATH, JSON.stringify( results ), "utf8" );
  cached = results;
  notify( );
  // Warm the image cache with each observation's first photo so the grid and
  // list have something to show offline.
  prefetch( results.observations
    .map( obs => obs.observation_photos?.[0]?.photo )
    .filter( Boolean )
    .map( photo => Photo.displayLocalOrRemoteOriginalPhoto( photo ) )
    .filter( Boolean ) );
  return results;
};

const toNumbers = ( value: unknown ): number[] => {
  if ( value == null || value === "" ) return [];
  const list = Array.isArray( value )
    ? value
    : String( value ).split( "," );
  return list.map( Number ).filter( n => !Number.isNaN( n ) );
};

const toStrings = ( value: unknown ): string[] => {
  if ( value == null || value === "" ) return [];
  return Array.isArray( value )
    ? value.map( String )
    : String( value ).split( "," );
};

const taxonLineage = ( obs: ApiObservation ): number[] => {
  const { taxon } = obs;
  if ( !taxon?.id ) return [];
  return [...( taxon.ancestor_ids || [] ), taxon.id];
};

const hasLocation = ( obs: ApiObservation ) => !!obs.geojson?.coordinates
  || ( obs.latitude != null && obs.longitude != null );

const inRange = ( value: string | undefined, min: unknown, max: unknown ) => {
  if ( !min && !max ) return true;
  if ( !value ) return false;
  const day = value.slice( 0, 10 );
  if ( min && day < String( min ).slice( 0, 10 ) ) return false;
  if ( max && day > String( max ).slice( 0, 10 ) ) return false;
  return true;
};

// Applies Explore's API params to the saved results on device. Location params
// are ignored, since the saved search already scoped the results to a place,
// as are params that need the server (native/introduced, reviewed, ...).
export const filterOfflineObservations = (
  observations: ApiObservation[],
  params: Params,
): ApiObservation[] => {
  const taxonIds = toNumbers( params.taxon_id );
  const withoutTaxonIds = new Set( toNumbers( params.without_taxon_id ) );
  const iconicTaxa = toStrings( params.iconic_taxa );
  const qualityGrades = toStrings( params.quality_grade );
  const months = toNumbers( params.month );
  const hours = toNumbers( params.hour );
  const userIds = toNumbers( params.user_id );
  const excludedUserIds = new Set(
    ( params.excludedUsers as { id: number }[] | undefined || [] ).map( u => u.id ),
  );

  const filtered = observations.filter( obs => {
    const lineage = taxonLineage( obs );
    if ( taxonIds.length && !taxonIds.some( id => lineage.includes( id ) ) ) return false;
    if ( lineage.some( id => withoutTaxonIds.has( id ) ) ) return false;
    if ( iconicTaxa.length ) {
      const iconic = obs.taxon?.iconic_taxon_name || "unknown";
      if ( !iconicTaxa.includes( iconic ) ) return false;
    }
    if ( qualityGrades.length && !qualityGrades.includes( obs.quality_grade ) ) return false;
    if ( params.observed_on && obs.observed_on?.slice( 0, 10 ) !== params.observed_on ) {
      return false;
    }
    if ( !inRange( obs.observed_on, params.d1, params.d2 ) ) return false;
    if ( params.created_on && obs.created_at?.slice( 0, 10 ) !== params.created_on ) {
      return false;
    }
    if ( !inRange( obs.created_at, params.created_d1, params.created_d2 ) ) return false;
    if ( months.length ) {
      const month = Number( obs.observed_on?.slice( 5, 7 ) );
      if ( !months.includes( month ) ) return false;
    }
    if ( hours.length ) {
      // time_observed_at carries the local offset, so this is the local hour
      const hour = Number( obs.time_observed_at?.slice( 11, 13 ) );
      if ( !obs.time_observed_at || !hours.includes( hour ) ) return false;
    }
    const photoCount = obs.observation_photos?.length || 0;
    const soundCount = obs.observation_sounds?.length || 0;
    if ( params.photos === true && !photoCount ) return false;
    if ( params.photos === false && photoCount ) return false;
    if ( params.sounds === true && !soundCount ) return false;
    if ( params.sounds === false && soundCount ) return false;
    if ( typeof params.captive === "boolean" && !!obs.captive !== params.captive ) return false;
    if ( params.popular && !obs.votes?.length ) return false;
    if ( userIds.length && !userIds.includes( obs.user?.id ) ) return false;
    if ( excludedUserIds.has( obs.user?.id ) ) return false;
    if ( params.geo === false && hasLocation( obs ) ) return false;
    return true;
  } );

  const { order_by: orderBy, order } = params;
  const sortValue = ( obs: ApiObservation ): string | number => {
    if ( orderBy === "observed_on" ) return obs.time_observed_at || obs.observed_on || "";
    if ( orderBy === "votes" ) return obs.votes?.length || 0;
    return obs.created_at || "";
  };
  const direction = order === "asc"
    ? 1
    : -1;
  return filtered.sort( ( a, b ) => {
    const av = sortValue( a );
    const bv = sortValue( b );
    if ( av === bv ) return 0;
    return ( av > bv
      ? 1
      : -1 ) * direction;
  } );
};
