import {
  CachesDirectoryPath, readDir, unlink,
} from "@dr.pogodin/react-native-fs";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "observationTileCache" );

// Observation tiles (the map's grid and points) seen before are kept here, so
// they show at once on a slow connection and with none at all. The native tile
// layer keeps one directory per URL template under it, i.e. one per search.
export const OBSERVATION_TILE_CACHE_PATH = `${CachesDirectoryPath}/observationTiles`;

// A cached tile older than this is still shown, then fetched again in the background
export const OBSERVATION_TILE_MAX_AGE_S = 60 * 60;

// A search's tiles not added to for this long are dropped...
const MAX_UNUSED_MS = 14 * 24 * 60 * 60 * 1000;
// ...and only this many of the most recent searches are kept
const MAX_SEARCHES = 50;

let pruned = false;

// Drops the tiles of searches not looked at in a while. Run once per launch, as
// the native layer never deletes anything itself.
export const pruneObservationTileCache = async ( ) => {
  if ( pruned ) return;
  pruned = true;
  try {
    const dirs = ( await readDir( OBSERVATION_TILE_CACHE_PATH ) )
      .filter( item => item.isDirectory( ) )
      // A directory's mtime moves when a zoom level is first added to it
      .sort( ( a, b ) => ( b.mtime?.getTime( ) ?? 0 ) - ( a.mtime?.getTime( ) ?? 0 ) );
    const now = Date.now( );
    const stale = dirs.filter( ( dir, i ) => i >= MAX_SEARCHES
      || now - ( dir.mtime?.getTime( ) ?? 0 ) > MAX_UNUSED_MS );
    await Promise.all( stale.map( dir => unlink( dir.path ).catch( ( ) => undefined ) ) );
  } catch ( error ) {
    // Nothing cached yet
    logger.debug( "Couldn't prune the observation tile cache", error );
  }
};
