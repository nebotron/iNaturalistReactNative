import {
  DocumentDirectoryPath, downloadFile, exists, moveFile, read, stat, unlink,
} from "@dr.pogodin/react-native-fs";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "populationDensity" );

// Population within 10 km of each point, built from GPW v4 census data by
// scripts/build_population_grid.py; keep these constants in sync with it
const GRID_URL = "https://raw.githubusercontent.com/nebotron/iNaturalistReactNative/main/data/population_10km.bin";
const GRID_PATH = `${DocumentDirectoryPath}/population_10km.bin`;
const STEP = 0.05;
const LAT_MAX = 80;
const LNG_MIN = -180;
const ROWS = 2720;
const COLS = 7200;
const MAX_POPULATION = 5e7;

let gridReady: Promise<boolean> | null = null;

// Downloads the grid the first time it's needed; later calls reuse the file
const ensureGrid = ( ): Promise<boolean> => {
  if ( !gridReady ) {
    gridReady = ( async ( ) => {
      if ( await exists( GRID_PATH ) && ( await stat( GRID_PATH ) ).size === ROWS * COLS ) {
        return true;
      }
      const tempPath = `${GRID_PATH}.download`;
      const { statusCode } = await downloadFile( { fromUrl: GRID_URL, toFile: tempPath } ).promise;
      if ( statusCode !== 200 || ( await stat( tempPath ) ).size !== ROWS * COLS ) {
        await unlink( tempPath ).catch( ( ) => undefined );
        throw new Error( `Population grid download failed: ${statusCode}` );
      }
      if ( await exists( GRID_PATH ) ) await unlink( GRID_PATH );
      await moveFile( tempPath, GRID_PATH );
      return true;
    } )( ).catch( e => {
      logger.error( "Failed to load population grid", e );
      gridReady = null;
      return false;
    } );
  }
  return gridReady;
};

const decode = ( q: number ) => ( 1 + MAX_POPULATION ) ** ( q / 255 ) - 1;

// Two adjacent cells of one row
const readPair = async ( row: number, col: number ): Promise<[number, number]> => {
  const bytes = atob( await read( GRID_PATH, 2, row * COLS + col, "base64" ) );
  return [decode( bytes.charCodeAt( 0 ) ), decode( bytes.charCodeAt( 1 ) )];
};

// People within 10 km of each point (bilinearly interpolated), or null when
// the grid can't be loaded
const populationWithin10Km = async (
  points: { lat: number; lng: number }[],
): Promise<number[] | null> => {
  if ( !( await ensureGrid( ) ) ) return null;
  try {
    return await Promise.all( points.map( async ( { lat, lng } ) => {
      const y = Math.min( Math.max( ( LAT_MAX - lat ) / STEP - 0.5, 0 ), ROWS - 1.001 );
      const x = Math.min( Math.max( ( lng - LNG_MIN ) / STEP - 0.5, 0 ), COLS - 2.001 );
      const row = Math.floor( y );
      const col = Math.floor( x );
      const fy = y - row;
      const fx = x - col;
      const [[a, b], [c, d]] = await Promise.all( [
        readPair( row, col ),
        readPair( row + 1, col ),
      ] );
      return ( a * ( 1 - fx ) + b * fx ) * ( 1 - fy ) + ( c * ( 1 - fx ) + d * fx ) * fy;
    } ) );
  } catch ( e ) {
    logger.error( "Failed to read population grid", e );
    return null;
  }
};

export default populationWithin10Km;
