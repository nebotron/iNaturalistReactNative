import {
  DocumentDirectoryPath, downloadFile, exists, hash, mkdir, moveFile, readDir, unlink,
} from "@dr.pogodin/react-native-fs";
import fetchCoarseUserLocation from "sharedHelpers/fetchCoarseUserLocation";

import CATALOG from "./audioIdCatalog.json";

// Which model Audio ID runs and which species it reports, from
// audioIdCatalog.json (scripts/bird_audio/birdnet/export_catalog.py). Near
// Seattle it is the bundled model; elsewhere BirdNET's model for the region,
// downloaded once. Species the BirdNET geomodel puts below GEO_THRESHOLD at the
// user's place and week are left out.

interface Model {
  name: string;
  species: number[]; // catalog species row for each model output, -1 if none
  center?: number[];
  radiusKm?: number;
  tier?: number;
  bboxes?: number[][]; // [south, north, west, east]
  file?: string;
  sha256?: string;
  sizeMb?: number;
}

// [scientific name, common name, iNaturalist taxon ID, geomodel index or -1]
const SPECIES = CATALOG.species as [string, string, number, number][];
const MODELS = CATALOG.models as Record<string, Model>;
const GEO_THRESHOLD = 0.03;
const MODEL_DIR = `${DocumentDirectoryPath}/audio-id`;

export interface AudioIdSpecies { name: string; commonName: string; taxonId: number }
export interface AudioIdSetup {
  modelName: string;
  modelPath: string | null; // null: the bundled model
  outputs: number[];
  species: AudioIdSpecies[]; // one per output, same order
  located: boolean;
}

const km = ( lat1: number, lng1: number, lat2: number, lng2: number ) => {
  const p = Math.PI / 180;
  const a = Math.sin( ( ( lat2 - lat1 ) * p ) / 2 ) ** 2
    + Math.cos( lat1 * p ) * Math.cos( lat2 * p ) * Math.sin( ( ( lng2 - lng1 ) * p ) / 2 ) ** 2;
  return 12742 * Math.asin( Math.sqrt( a ) );
};

// The most specific region whose box holds the point, else the global model.
export const pickModel = ( lat: number, lng: number ): string => {
  const { center, radiusKm } = MODELS.seattle;
  if ( center && radiusKm && km( lat, lng, center[0], center[1] ) <= radiusKm ) return "seattle";
  const best = Object.entries( MODELS ).reduce( ( b, [key, m] ) => {
    const boxes = ( m.bboxes || [] ).filter(
      ( [s, n, w, e] ) => lat >= s && lat <= n && lng >= w && lng <= e,
    );
    if ( !boxes.length ) return b;
    const tier = m.tier || 0;
    const area = Math.min( ...boxes.map( ( [s, n, w, e] ) => ( n - s ) * ( e - w ) ) );
    return tier > b.tier || ( tier === b.tier && area < b.area )
      ? { key, tier, area }
      : b;
  }, { key: "global", tier: -1, area: Infinity } );
  return best.key;
};

// BirdNET's 48-week year: four weeks per month.
const birdnetWeek = ( d: Date ) => d.getMonth( ) * 4
  + Math.min( 4, Math.floor( ( d.getDate( ) - 1 ) / 7 ) + 1 );

// Downloads a model once, checks its SHA-256, and drops any other downloaded
// model so only one (~75 MB) is kept.
const ensureModel = async (
  m: Model,
  onProgress: ( fraction: number ) => void,
): Promise<string> => {
  const name = m.file!.split( "/" ).pop( )!;
  const path = `${MODEL_DIR}/${name}`;
  if ( await exists( path ) ) return path;
  await mkdir( MODEL_DIR );
  ( await readDir( MODEL_DIR ) ).forEach( f => { unlink( f.path ).catch( ( ) => undefined ); } );
  const tmp = `${path}.part`;
  const { promise } = downloadFile( {
    fromUrl: `${CATALOG.baseUrl}${m.file}`,
    toFile: tmp,
    progressInterval: 500,
    progress: ( { bytesWritten, contentLength } ) => onProgress(
      bytesWritten / ( contentLength || 1 ),
    ),
  } );
  const { statusCode } = await promise;
  if ( statusCode !== 200 || ( await hash( tmp, "sha256" ) ) !== m.sha256 ) {
    await unlink( tmp ).catch( ( ) => undefined );
    throw new Error( `Could not download the ${m.name} sound model` );
  }
  await moveFile( tmp, path );
  return path;
};

export const prepareAudioId = async (
  geo: ( lat: number, lng: number, week: number ) => Promise<number[]>,
  onStatus: ( status: string ) => void,
): Promise<AudioIdSetup> => {
  const location = await fetchCoarseUserLocation( );
  const key = location
    ? pickModel( location.latitude, location.longitude )
    : "seattle";
  const model = MODELS[key];
  let modelPath: string | null = null;
  if ( model.file ) {
    modelPath = await ensureModel( model, f => onStatus(
      `Downloading the ${model.name} sound model (${model.sizeMb} MB): ${Math.round( f * 100 )}%`,
    ) );
  }
  const occurrence = location
    ? await geo( location.latitude, location.longitude, birdnetWeek( new Date( ) ) )
    : null;
  const outputs: number[] = [];
  const species: AudioIdSpecies[] = [];
  model.species.forEach( ( row, output ) => {
    if ( row < 0 ) return;
    const [name, commonName, taxonId, geoIndex] = SPECIES[row];
    if ( occurrence && geoIndex >= 0 && occurrence[geoIndex] < GEO_THRESHOLD ) return;
    outputs.push( output );
    species.push( { name, commonName, taxonId } );
  } );
  return {
    modelName: model.name, modelPath, outputs, species, located: !!location,
  };
};
