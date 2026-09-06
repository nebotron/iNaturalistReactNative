import { Image as RNImage } from "react-native";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import prepareCropSource from "sharedHelpers/prepareCropSource";

// What each stage of a preload cost, and when it finished. The wait between
// photos in a bulk crop is whatever is left of this when the user advances, so
// the editor reports it (crop_photo_slow) rather than leaving the wait as one
// opaque number.
export interface PreloadTiming {
  exportMs: number;
  prepareMs: number;
  finishedAt: number;
}

export interface PreloadResult {
  // The untouched original, which is what a crop is finally applied to.
  localUri: string;
  // The display-sized file decoded from it, which is what the cropper draws.
  displayUri: string;
  size: { w: number; h: number };
  crop: NormalizedCrop;
  timing: PreloadTiming;
}

// Module-level cache so preloaded data survives navigation.replace cycles
export const preloadCache = new Map<string, PreloadResult>( );
// Track in-flight loads by their promise so callers can await (and dedupe)
// an ongoing preload instead of kicking off duplicate, contending work.
const preloadInFlight = new Map<string, Promise<PreloadResult | null>>( );

async function loadImageData(
  imageUri: string,
  cropSourceUri: string,
  existingSavedCrop: NormalizedCrop | null,
): Promise<PreloadResult | null> {
  const startedAt = Date.now( );
  const resolvedUri = await ensureLocalImageForCrop( cropSourceUri, "original" );
  const exportedAt = Date.now( );
  // One decode of the photo, off the screen the user is still cropping on,
  // producing the size, the framing and the file the cropper will draw.
  const prepared = await prepareCropSource( imageUri, resolvedUri, existingSavedCrop );
  if ( !prepared ) {
    return null;
  }
  // Warm React Native's image pipeline for the file the cropper is about to
  // display, so its <Image> doesn't start a cold read + decode at the moment we
  // show it. Fire-and-forget: it can only save time.
  RNImage.prefetch?.( prepared.displayUri )?.catch?.( ( ) => {} );
  const finishedAt = Date.now( );
  return {
    localUri: resolvedUri,
    displayUri: prepared.displayUri,
    size: prepared.size,
    crop: prepared.crop,
    timing: {
      exportMs: exportedAt - startedAt,
      prepareMs: finishedAt - exportedAt,
      finishedAt,
    },
  };
}

// Returns a promise resolving to the preload result. Reuses the module-level
// cache and dedupes concurrent loads for the same imageUri so the same
// expensive asset export + subject detection never runs twice at once.
export function preloadImage(
  imageUri: string,
  cropSourceUri: string,
  existingSavedCrop: NormalizedCrop | null,
): Promise<PreloadResult | null> {
  const cached = preloadCache.get( imageUri );
  if ( cached ) {
    return Promise.resolve( cached );
  }
  const inFlight = preloadInFlight.get( imageUri );
  if ( inFlight ) {
    return inFlight;
  }
  const promise = loadImageData( imageUri, cropSourceUri, existingSavedCrop )
    .then( result => {
      if ( result ) {
        preloadCache.set( imageUri, result );
      }
      return result;
    } )
    .catch( ( ) => null )
    .finally( ( ) => {
      preloadInFlight.delete( imageUri );
    } );
  preloadInFlight.set( imageUri, promise );
  return promise;
}

interface PreloadRequest {
  imageUri: string;
  cropSourceUri: string;
  existingSavedCrop: NormalizedCrop | null;
  resolve: ( result: PreloadResult | null ) => void;
}

// Each preload runs a heavy native asset export + subject detection. Kicking
// off a whole batch at once saturates the device and stalls rendering (e.g.
// the first crop image appearing). Cap how many run concurrently and process
// the rest from a queue in order, so the nearest-needed images load first.
const PRELOAD_CONCURRENCY = 2;
const preloadQueue: PreloadRequest[] = [];
const preloadQueued = new Map<string, Promise<PreloadResult | null>>( );
let activePreloadCount = 0;

function startNextPreload( ) {
  const request = preloadQueue.shift( )!;
  preloadQueued.delete( request.imageUri );
  // May have been resolved or started directly (e.g. the user advanced to it)
  // since it was enqueued; don't waste a slot on already-done/running work.
  const cached = preloadCache.get( request.imageUri );
  if ( cached ) {
    request.resolve( cached );
    return;
  }
  const inFlight = preloadInFlight.get( request.imageUri );
  if ( inFlight ) {
    inFlight.then( request.resolve, ( ) => request.resolve( null ) );
    return;
  }
  activePreloadCount += 1;
  preloadImage(
    request.imageUri,
    request.cropSourceUri,
    request.existingSavedCrop,
  ).then( request.resolve, ( ) => request.resolve( null ) ).finally( ( ) => {
    activePreloadCount -= 1;
    // eslint-disable-next-line no-use-before-define
    pumpPreloadQueue( );
  } );
}

function pumpPreloadQueue( ) {
  while ( activePreloadCount < PRELOAD_CONCURRENCY && preloadQueue.length > 0 ) {
    startNextPreload( );
  }
}

// Enqueue a background preload that respects PRELOAD_CONCURRENCY, resolving
// with the result so a caller that needs the data (rather than just warming
// the cache) can await its turn in the queue. Already cached, in-flight, or
// queued URIs reuse the existing work so callers can re-enqueue freely (e.g.
// on every navigation.replace) without piling up duplicate loads.
export function enqueuePreload(
  imageUri: string,
  cropSourceUri: string,
  existingSavedCrop: NormalizedCrop | null,
): Promise<PreloadResult | null> {
  const cached = preloadCache.get( imageUri );
  if ( cached ) {
    return Promise.resolve( cached );
  }
  const inFlight = preloadInFlight.get( imageUri );
  if ( inFlight ) {
    return inFlight;
  }
  const queued = preloadQueued.get( imageUri );
  if ( queued ) {
    return queued;
  }
  let resolve: ( result: PreloadResult | null ) => void = ( ) => {};
  const promise = new Promise<PreloadResult | null>( res => {
    resolve = res;
  } );
  preloadQueued.set( imageUri, promise );
  preloadQueue.push( {
    imageUri, cropSourceUri, existingSavedCrop, resolve,
  } );
  pumpPreloadQueue( );
  return promise;
}
