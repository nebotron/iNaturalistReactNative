import { MainBundlePath, read } from "@dr.pogodin/react-native-fs";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "populationDensity" );

// Population within 10 km of each point, built from GPW v4 census data by
// scripts/build_population_grid.py and bundled in the iOS app; keep these
// constants in sync with it
const GRID_PATH = `${MainBundlePath}/population_10km.bin`;
const STEP = 0.05;
const LAT_MAX = 80;
const LNG_MIN = -180;
const ROWS = 2720;
const COLS = 7200;
const MAX_POPULATION = 5e7;

const decode = ( q: number ) => ( 1 + MAX_POPULATION ) ** ( q / 255 ) - 1;

// Two adjacent cells of one row
const readPair = async ( row: number, col: number ): Promise<[number, number]> => {
  const bytes = atob( await read( GRID_PATH, 2, row * COLS + col, "base64" ) );
  return [decode( bytes.charCodeAt( 0 ) ), decode( bytes.charCodeAt( 1 ) )];
};

// People within 10 km of each point (bilinearly interpolated), or null when
// the grid isn't bundled (Android)
const populationWithin10Km = async (
  points: { lat: number; lng: number }[],
): Promise<number[] | null> => {
  if ( !MainBundlePath ) return null;
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
