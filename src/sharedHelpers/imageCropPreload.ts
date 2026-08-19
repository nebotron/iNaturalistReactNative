import { Image as RNImage } from "react-native";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import getCropForUri from "sharedHelpers/getCropForUri";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";

export interface PreloadResult {
  localUri: string;
  size: { w: number; h: number };
  crop: NormalizedCrop;
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
  const resolvedUri = await ensureLocalImageForCrop( cropSourceUri, "original" );
  const size = await new Promise<{ w: number; h: number } | null>( resolve => {
    RNImage.getSize(
      resolvedUri,
      ( w, h ) => resolve( { w, h } ),
      ( ) => resolve( null ),
    );
  } );
  if ( !size ) {
    return null;
  }
  // Warm React Native's image pipeline for the file the cropper is about to
  // display, so its <Image> doesn't start a cold read + decode of a full-size
  // photo at the moment we show it. Fire-and-forget: it can only save time.
  RNImage.prefetch?.( resolvedUri )?.catch?.( ( ) => {} );
  const crop = existingSavedCrop
    ?? await getCropForUri( imageUri, resolvedUri, size.w, size.h );
  return { localUri: resolvedUri, size, crop };
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
