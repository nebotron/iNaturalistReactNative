import {
  DocumentDirectoryPath, downloadFile, exists, mkdir, unlink,
} from "@dr.pogodin/react-native-fs";
import { searchObservations } from "api/observations";
import type { ApiObservation } from "api/types";
import { getUserAgent } from "api/userAgent";
import {
  addPageParamsForExplore,
  getNextPageParamForExplore,
} from "components/Explore/helpers/exploreParams";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import Realm from "realm";
import Observation from "realmModels/Observation";
import ObservationSound from "realmModels/ObservationSound";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "offlineExploreResults" );

const PAGE_SIZE = 200;
// Per save; each save adds to what's already saved
export const MAX_OFFLINE_OBSERVATIONS = 5000;
// Base map tiles saved alongside the results, stored as {z}/{x}/{y}.png
export const OFFLINE_TILES_PATH = `${DocumentDirectoryPath}/offlineExploreTiles`;
const TILE_URL = "https://tile.openstreetmap.org";
// Per save, from the lowest zoom up, so a wide area gets fewer zoom levels
const MAX_TILES = 1000;
export const MAX_TILE_ZOOM = 16;

type Params = Record<string, unknown>;

// Saved Explore search results, kept in their own indexed Realm so they can be
// browsed and filtered further with no connection. Each row keeps the API
// response as JSON for display, plus the columns needed to query it.
export class OfflineExploreObservation extends Realm.Object {
  uuid!: string;

  json!: string;

  taxon_lineage!: Realm.List<number>;

  iconic_taxon_name!: string;

  quality_grade!: string;

  observed_day?: number;

  observed_at?: Date;

  month?: number;

  hour?: number;

  created_day!: number;

  created_at!: Date;

  user_id?: number;

  place_ids!: Realm.List<number>;

  project_ids!: Realm.List<number>;

  latitude?: number;

  longitude?: number;

  photos_count!: number;

  sounds_count!: number;

  votes_count!: number;

  captive!: boolean;

  static schema: Realm.ObjectSchema = {
    name: "OfflineExploreObservation",
    primaryKey: "uuid",
    properties: {
      uuid: "string",
      json: "string",
      taxon_lineage: "int[]",
      iconic_taxon_name: { type: "string", indexed: true },
      quality_grade: { type: "string", indexed: true },
      // Days as yyyymmdd ints so date ranges are indexed int comparisons
      observed_day: { type: "int", optional: true, indexed: true },
      observed_at: { type: "date", optional: true, indexed: true },
      month: { type: "int", optional: true, indexed: true },
      hour: { type: "int", optional: true, indexed: true },
      created_day: { type: "int", indexed: true },
      created_at: { type: "date", indexed: true },
      user_id: { type: "int", optional: true, indexed: true },
      place_ids: "int[]",
      project_ids: "int[]",
      latitude: { type: "double", optional: true },
      longitude: { type: "double", optional: true },
      photos_count: "int",
      sounds_count: "int",
      votes_count: { type: "int", indexed: true },
      captive: "bool",
    },
  };
}

export const offlineExploreRealmConfig: Realm.Configuration = {
  schema: [OfflineExploreObservation],
  schemaVersion: 1,
  path: `${DocumentDirectoryPath}/offlineExplore.realm`,
};

let realm: Realm | null = null;
let opening: Promise<Realm | null> | null = null;
// Bumped on every write so subscribers re-query
let version = 0;
const listeners = new Set<( ) => void>( );
const notify = ( ) => {
  version += 1;
  listeners.forEach( l => l( ) );
};

export const subscribeOfflineExploreResults = ( listener: ( ) => void ) => {
  listeners.add( listener );
  return ( ) => { listeners.delete( listener ); };
};

export const getOfflineExploreVersion = ( ) => version;

export const getOfflineExploreRealm = ( ) => realm;

export const openOfflineExploreRealm = async ( ) => {
  if ( realm ) return realm;
  opening ??= Realm.open( offlineExploreRealmConfig ).then( opened => {
    realm = opened;
    notify( );
    return opened;
  } ).catch( e => {
    logger.error( "Failed to open offline explore results", e );
    opening = null;
    return null;
  } );
  return opening;
};

const allSaved = ( db: Realm ) => db.objects<OfflineExploreObservation>(
  "OfflineExploreObservation",
);

export const countOfflineObservations = ( ) => ( realm
  ? allSaved( realm ).length
  : 0 );

export const deleteOfflineExploreResults = async ( ) => {
  const db = await openOfflineExploreRealm( );
  if ( !db ) return;
  db.write( ( ) => db.deleteAll( ) );
  notify( );
  await unlink( OFFLINE_TILES_PATH ).catch( ( ) => undefined );
};

interface Bounds {
  swlat: number;
  swlng: number;
  nelat: number;
  nelng: number;
}

const tileX = ( lng: number, z: number ) => Math.min(
  Math.floor( ( ( lng + 180 ) / 360 ) * 2 ** z ),
  2 ** z - 1,
);

const tileY = ( lat: number, z: number ) => {
  const rad = ( Math.max( Math.min( lat, 85 ), -85 ) * Math.PI ) / 180;
  const y = ( 1 - Math.log( Math.tan( rad ) + 1 / Math.cos( rad ) ) / Math.PI ) / 2;
  return Math.min( Math.floor( y * 2 ** z ), 2 ** z - 1 );
};

// Saves the base map tiles covering bounds, skipping ones already saved
const downloadOfflineTiles = async ( {
  swlat, swlng, nelat, nelng,
}: Bounds ) => {
  const tiles: { z: number; x: number; y: number }[] = [];
  for ( let z = 0; z <= MAX_TILE_ZOOM; z += 1 ) {
    const [x1, x2] = [tileX( swlng, z ), tileX( nelng, z )];
    const [y1, y2] = [tileY( nelat, z ), tileY( swlat, z )];
    if ( tiles.length + ( x2 - x1 + 1 ) * ( y2 - y1 + 1 ) > MAX_TILES ) break;
    for ( let x = x1; x <= x2; x += 1 ) {
      for ( let y = y1; y <= y2; y += 1 ) tiles.push( { z, x, y } );
    }
  }
  const headers = { "User-Agent": getUserAgent( ) };
  for ( let i = 0; i < tiles.length; i += 1 ) {
    const { z, x, y } = tiles[i];
    const path = `${OFFLINE_TILES_PATH}/${z}/${x}/${y}.png`;
    /* eslint-disable no-await-in-loop */
    if ( !( await exists( path ) ) ) {
      await mkdir( `${OFFLINE_TILES_PATH}/${z}/${x}` );
      const { statusCode } = await downloadFile( {
        fromUrl: `${TILE_URL}/${z}/${x}/${y}.png`,
        toFile: path,
        headers,
      } ).promise;
      if ( statusCode !== 200 ) await unlink( path ).catch( ( ) => undefined );
    }
    /* eslint-enable no-await-in-loop */
  }
};

const dayInt = ( value?: string | null ) => {
  const day = value?.slice( 0, 10 ).replace( /-/g, "" );
  return day && /^\d{8}$/.test( day )
    ? Number( day )
    : undefined;
};

const toRow = ( obs: ApiObservation ) => {
  const { taxon } = obs;
  const coords = obs.geojson?.coordinates;
  const timeObservedAt = obs.time_observed_at;
  const observedAt = timeObservedAt || obs.observed_on;
  const hour = timeObservedAt
    ? Number( timeObservedAt.slice( 11, 13 ) )
    : undefined;
  const month = Number( obs.observed_on?.slice( 5, 7 ) );
  return {
    uuid: obs.uuid,
    json: JSON.stringify( obs ),
    taxon_lineage: taxon?.id
      ? [...( taxon.ancestor_ids || [] ), taxon.id]
      : [],
    iconic_taxon_name: taxon?.iconic_taxon_name || "unknown",
    quality_grade: obs.quality_grade || "",
    observed_day: dayInt( obs.observed_on ),
    observed_at: observedAt
      ? new Date( observedAt )
      : undefined,
    month: month || undefined,
    hour: Number.isNaN( hour )
      ? undefined
      : hour,
    created_day: dayInt( obs.created_at ) || 0,
    created_at: new Date( obs.created_at || 0 ),
    user_id: obs.user?.id,
    place_ids: obs.place_ids || [],
    project_ids: obs.project_ids || [],
    longitude: coords?.[0] ?? obs.longitude ?? undefined,
    latitude: coords?.[1] ?? obs.latitude ?? undefined,
    photos_count: obs.observation_photos?.length || 0,
    sounds_count: obs.observation_sounds?.length || 0,
    votes_count: obs.votes?.length || 0,
    captive: !!obs.captive,
  };
};

const extendBounds = ( bounds: Bounds | undefined, obs: ApiObservation ) => {
  const { latitude, longitude } = toRow( obs );
  if ( latitude == null || longitude == null ) return bounds;
  return {
    swlat: Math.min( bounds?.swlat ?? latitude, latitude ),
    swlng: Math.min( bounds?.swlng ?? longitude, longitude ),
    nelat: Math.max( bounds?.nelat ?? latitude, latitude ),
    nelng: Math.max( bounds?.nelng ?? longitude, longitude ),
  };
};

const FIELDS = {
  ...Observation.ADVANCED_MODE_LIST_FIELDS,
  captive: true,
  geojson: true,
  place_ids: true,
  project_ids: true,
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

// Adds this search's results to the saved results. Observations already saved
// are updated in place, so saving overlapping searches makes no duplicates.
export const downloadOfflineExploreResults = async (
  queryParams: Params,
  onProgress?: ( count: number ) => void,
) => {
  const db = await openOfflineExploreRealm( );
  if ( !db ) throw new Error( "Offline explore database unavailable" );
  const before = allSaved( db ).length;
  const baseParams = {
    ...queryParams,
    per_page: PAGE_SIZE,
    fields: FIELDS,
    ttl: -1,
  };
  const apiToken = await getJWT( true );
  let fetched = 0;
  let pageParam: unknown;
  let bounds: Bounds | undefined;
  while ( fetched < MAX_OFFLINE_OBSERVATIONS ) {
    // eslint-disable-next-line no-await-in-loop
    const response = await searchObservations(
      addPageParamsForExplore( { ...baseParams, pageParam } ),
      { api_token: apiToken },
    );
    const results: ApiObservation[] = ( response?.results || [] )
      .filter( ( obs: ApiObservation ) => obs.uuid )
      .slice( 0, MAX_OFFLINE_OBSERVATIONS - fetched );
    if ( !results.length ) break;
    db.write( ( ) => {
      results.forEach( obs => {
        db.create( "OfflineExploreObservation", toRow( obs ), Realm.UpdateMode.Modified );
      } );
    } );
    bounds = results.reduce( extendBounds, bounds );
    fetched += results.length;
    notify( );
    onProgress?.( fetched );
    pageParam = getNextPageParamForExplore( response, baseParams );
    if ( pageParam == null || response.results.length < PAGE_SIZE ) break;
  }
  if ( bounds ) {
    // The results are saved even if the map can't be
    await downloadOfflineTiles( bounds ).catch( e => {
      logger.error( "Failed to save offline map tiles", e );
    } );
  }
  const total = allSaved( db ).length;
  return { added: total - before, total };
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

const KM_PER_DEGREE = 111.32;

// Turns Explore's API params into a Realm query over the saved results. Params
// that need the server (native/introduced, reviewed, ranks, ...) are ignored.
export const queryOfflineObservations = ( db: Realm, params: Params ) => {
  const clauses: string[] = [];
  const args: unknown[] = [];
  const add = ( clause: string, ...values: unknown[] ) => {
    // Number the placeholders so each clause can use its own args
    clauses.push( clause.replace( /\$(\d+)/g, ( _, i ) => `$${args.length + Number( i )}` ) );
    args.push( ...values );
  };

  const taxonIds = toNumbers( params.taxon_id );
  if ( taxonIds.length ) add( "ANY taxon_lineage IN $0", taxonIds );
  const withoutTaxonIds = toNumbers( params.without_taxon_id );
  if ( withoutTaxonIds.length ) add( "NONE taxon_lineage IN $0", withoutTaxonIds );
  const iconicTaxa = toStrings( params.iconic_taxa );
  if ( iconicTaxa.length ) add( "iconic_taxon_name IN $0", iconicTaxa );
  const qualityGrades = toStrings( params.quality_grade );
  if ( qualityGrades.length ) add( "quality_grade IN $0", qualityGrades );

  const observedOn = dayInt( params.observed_on as string );
  if ( observedOn ) add( "observed_day == $0", observedOn );
  const d1 = dayInt( params.d1 as string );
  if ( d1 ) add( "observed_day >= $0", d1 );
  const d2 = dayInt( params.d2 as string );
  if ( d2 ) add( "observed_day <= $0", d2 );
  const createdOn = dayInt( params.created_on as string );
  if ( createdOn ) add( "created_day == $0", createdOn );
  const createdD1 = dayInt( params.created_d1 as string );
  if ( createdD1 ) add( "created_day >= $0", createdD1 );
  const createdD2 = dayInt( params.created_d2 as string );
  if ( createdD2 ) add( "created_day <= $0", createdD2 );
  const months = toNumbers( params.month );
  if ( months.length ) add( "month IN $0", months );
  const hours = toNumbers( params.hour );
  if ( hours.length ) add( "hour IN $0", hours );

  if ( params.photos === true ) add( "photos_count > 0" );
  if ( params.photos === false ) add( "photos_count == 0" );
  if ( params.sounds === true ) add( "sounds_count > 0" );
  if ( params.sounds === false ) add( "sounds_count == 0" );
  if ( typeof params.captive === "boolean" ) add( "captive == $0", params.captive );
  if ( params.popular ) add( "votes_count > 0" );

  const userIds = toNumbers( params.user_id );
  if ( userIds.length ) add( "user_id IN $0", userIds );
  const notUserIds = toNumbers( params.not_user_id );
  if ( notUserIds.length ) add( "NOT user_id IN $0", notUserIds );
  const projectIds = toNumbers( params.project_id );
  if ( projectIds.length ) add( "ANY project_ids IN $0", projectIds );

  if ( params.geo === false ) add( "latitude == nil" );
  const placeIds = toNumbers( params.place_id );
  if ( placeIds.length ) add( "ANY place_ids IN $0", placeIds );
  if ( params.swlat != null ) {
    add(
      "latitude BETWEEN {$0, $1}",
      Number( params.swlat ),
      Number( params.nelat ),
    );
    const swlng = Number( params.swlng );
    const nelng = Number( params.nelng );
    if ( swlng <= nelng ) {
      add( "longitude BETWEEN {$0, $1}", swlng, nelng );
    } else {
      // Bounds crossing the antimeridian
      add( "(longitude >= $0 OR longitude <= $1)", swlng, nelng );
    }
  }
  if ( params.lat != null && params.lng != null ) {
    // Bounding box around the radius
    const lat = Number( params.lat );
    const lng = Number( params.lng );
    const radiusKm = Number( params.radius ) || 1;
    const dLat = radiusKm / KM_PER_DEGREE;
    const dLng = dLat / Math.max( Math.cos( ( lat * Math.PI ) / 180 ), 0.01 );
    add( "latitude BETWEEN {$0, $1}", lat - dLat, lat + dLat );
    add( "longitude BETWEEN {$0, $1}", lng - dLng, lng + dLng );
  }

  let results = allSaved( db );
  if ( clauses.length ) results = results.filtered( clauses.join( " AND " ), ...args );

  const sortKey = {
    observed_on: "observed_at",
    votes: "votes_count",
  }[params.order_by as string] || "created_at";
  return results.sorted( sortKey, params.order !== "asc" );
};
