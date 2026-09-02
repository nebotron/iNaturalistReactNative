import { fileExtension } from "sharedHelpers/importedFileTypes";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "groupPhotoResolution" );

interface Drawn {
  type: string;
  longEdge: number;
  fullResolution: boolean;
}

// The largest image each photo's cell actually painted, keyed by the photo.
const drawn = new Map<string, Drawn>( );
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// Quiet period after the last cell paints, so an import contributes one line
// rather than one per photo. This log floods easily: a single import of RAW
// photos once accounted for 1,137 of the 3,000 entries in it.
const FLUSH_DELAY_MS = 5000;

const minMedianMax = ( values: number[] ): string => {
  const sorted = [...values].sort( ( a, b ) => a - b );
  return [
    sorted[0],
    sorted[Math.floor( sorted.length / 2 )],
    sorted[sorted.length - 1],
  ].join( "/" );
};

const flush = ( ) => {
  flushTimer = null;
  const samples = [...drawn.values( )];
  drawn.clear( );
  if ( samples.length === 0 ) {
    return;
  }
  const types = [...new Set( samples.map( sample => sample.type ) )];
  logger.infoWithExtra( "group_photo_resolution", {
    photos: samples.length,
    // min/median/max of the long edge actually painted, per file type. The
    // generator never upscales, so for a photo that got its full-resolution
    // file this is the source's own effective decoded resolution -- a camera
    // RAW coming back far below the sensor's dimensions was served the preview
    // the camera baked into the file rather than a demosaic of the sensor
    // data, which is the difference between a sharp cell and a soft one.
    longEdge: types.map( type => `${type}:${minMedianMax(
      samples.filter( sample => sample.type === type ).map( sample => sample.longEdge ),
    )}` ).join( " " ),
    // How many of them got that full-resolution file at all. The rest are
    // showing the tile-sized thumbnail, whatever the cell is zoomed to.
    fullResolution: samples.filter( sample => sample.fullResolution ).length,
  } );
};

// Records the size of the image a Group Photos cell actually painted, so the
// log can say whether photos are being drawn at their real resolution or at
// some smaller preview standing in for them.
const recordGroupPhotoDrawnResolution = (
  cropSourceUri: string,
  width: number,
  height: number,
  fullResolution: boolean,
): void => {
  const longEdge = Math.max( width, height );
  if ( longEdge <= 0 ) {
    return;
  }
  // A cell upgrades its source in place, so keep the best it ever managed
  // rather than whichever file happened to paint last.
  const previous = drawn.get( cropSourceUri );
  if ( previous && previous.longEdge >= longEdge ) {
    return;
  }
  drawn.set( cropSourceUri, {
    type: fileExtension( cropSourceUri ),
    longEdge,
    fullResolution,
  } );
  if ( flushTimer ) {
    clearTimeout( flushTimer );
  }
  flushTimer = setTimeout( flush, FLUSH_DELAY_MS );
};

export default recordGroupPhotoDrawnResolution;
