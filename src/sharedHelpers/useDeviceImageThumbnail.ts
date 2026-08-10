import { exists, mkdir } from "@dr.pogodin/react-native-fs";
import { deviceThumbnailsPath } from "appConstants/paths";
import { useEffect, useState } from "react";
import { NativeModules } from "react-native";

interface ImageCropperModule {
  createThumbnail: (
    inputPath: string,
    maxPixel: number,
    outputPath: string,
  ) => Promise<string>;
}

const { ImageCropper } = NativeModules as { ImageCropper?: ImageCropperModule };

// Bump when the native decode changes, so thumbnails already on disk under the
// old key are treated as misses and regenerated rather than reused stale (this
// is what made the Group Photos crop overlay stay pixelated even after
// ImageCropper.m started decoding accurately -- the on-disk cache from before
// that fix kept getting served).
const CACHE_VERSION = 3;

const cacheKey = ( uri: string, maxPixel: number ) => `${uri}:${maxPixel}:v${CACHE_VERSION}`;

// djb2 → stable hex filename so a photo's thumbnail is reused across scroll
// recycling and app launches (uris can be long ph:// / file:// paths).
function hashKey( key: string ): string {
  let hash = 5381;
  for ( let i = 0; i < key.length; i += 1 ) {
    // eslint-disable-next-line no-bitwise
    hash = ( ( hash << 5 ) + hash ) ^ key.charCodeAt( i );
    // eslint-disable-next-line no-bitwise
    hash >>>= 0; // keep unsigned 32-bit
  }
  return hash.toString( 16 );
}

// Resolved thumbnails are kept for the life of the process: a grid that has
// already shown a photo must be able to show it again instantly when the user
// scrolls back, and the entries are just short strings.
const memoryCache = new Map<string, string>( );

// Cap concurrent native thumbnail generations so a fast scroll through a large
// library doesn't fire hundreds of decodes at once.
const MAX_CONCURRENCY = 4;

interface Job {
  key: string;
  uri: string;
  maxPixel: number;
  // Number of live callers that still want this thumbnail. When it drops to
  // zero before the job starts, the job is abandoned: the cell that asked for
  // it has been recycled away and generating it now would only delay the
  // thumbnails that are actually on screen.
  waiters: number;
  started: boolean;
  cancelled: boolean;
  promise: Promise<string | null>;
  resolve: ( value: string | null ) => void;
}

const jobs = new Map<string, Job>( );
// Pending work is served last-in-first-out, and visible cells jump ahead of
// prefetches. A queue served in request order is what made scrolling back feel
// like previews had "unloaded": the thumbnails for the rows now on screen sat
// behind a backlog of requests from every row already scrolled past.
const visibleStack: Job[] = [];
const prefetchStack: Job[] = [];
let active = 0;

let dirReady: Promise<void> | null = null;
const ensureDir = ( ) => {
  if ( !dirReady ) dirReady = mkdir( deviceThumbnailsPath ).catch( ( ) => {} );
  return dirReady;
};

const takeNext = ( ): Job | null => {
  const stacks = [visibleStack, prefetchStack];
  let next: Job | null = null;
  for ( let i = 0; i < stacks.length && !next; i += 1 ) {
    const stack = stacks[i];
    while ( !next && stack.length > 0 ) {
      // A job can appear in a stack more than once (requested again, or
      // promoted from prefetch to visible); started/cancelled skips the dupes.
      const job = stack.pop( ) as Job;
      if ( !job.started && !job.cancelled ) next = job;
    }
  }
  return next;
};

// A native generation that never settles must not hold a concurrency slot for
// the life of the process: four of those wedge the queue and every remaining
// cell stays blank forever. Giving up frees the slot and leaves the cell to
// display the original uri instead.
const GENERATION_TIMEOUT_MS = 15000;

const withTimeout = ( promise: Promise<string> ): Promise<string | null> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race( [
    promise,
    new Promise<null>( resolve => {
      timer = setTimeout( ( ) => resolve( null ), GENERATION_TIMEOUT_MS );
    } ),
  ] ).finally( ( ) => clearTimeout( timer ) );
};

const runJob = async ( job: Job ) => {
  let result: string | null = null;
  try {
    await ensureDir( );
    const outputPath = `${deviceThumbnailsPath}/${hashKey( job.key )}.jpg`;
    result = await exists( outputPath )
      ? `file://${outputPath}`
      : ( await withTimeout(
        ImageCropper!.createThumbnail( job.uri, job.maxPixel, outputPath ),
      ) ) || null;
  } catch {
    result = null;
  }
  if ( result ) memoryCache.set( job.key, result );
  jobs.delete( job.key );
  job.resolve( result );
};

// Starts as many queued jobs as the concurrency cap allows, and starts the
// next one as each finishes.
const pump = ( ) => {
  if ( active >= MAX_CONCURRENCY ) return;
  const job = takeNext( );
  if ( !job ) return;
  job.started = true;
  active += 1;
  runJob( job ).then( ( ) => {
    active -= 1;
    pump( );
  } );
  pump( );
};

const scheduleJob = ( uri: string, maxPixel: number, visible: boolean ): Job => {
  const key = cacheKey( uri, maxPixel );
  let job = jobs.get( key );
  if ( !job ) {
    let resolveJob: ( value: string | null ) => void = ( ) => {};
    const promise = new Promise<string | null>( resolve => {
      resolveJob = resolve;
    } );
    job = {
      key,
      uri,
      maxPixel,
      waiters: 0,
      started: false,
      cancelled: false,
      promise,
      resolve: resolveJob,
    };
    jobs.set( key, job );
  }
  job.waiters += 1;
  if ( !job.started ) {
    ( visible
      ? visibleStack
      : prefetchStack ).push( job );
    pump( );
  }
  return job;
};

interface ThumbnailRequest {
  promise: Promise<string | null>;
  release: ( ) => void;
}

// Requests a thumbnail on behalf of a cell that is on screen now. Callers must
// call release() when they no longer need it (unmount, or recycled onto a
// different photo) so an unstarted job can be dropped.
const requestDeviceImageThumbnail = (
  uri: string,
  maxPixel: number,
): ThumbnailRequest => {
  const key = cacheKey( uri, maxPixel );
  const cached = memoryCache.get( key );
  if ( cached ) {
    return { promise: Promise.resolve( cached ), release: ( ) => {} };
  }
  const job = scheduleJob( uri, maxPixel, true );
  let released = false;
  return {
    promise: job.promise,
    release: ( ) => {
      if ( !released ) {
        released = true;
        job.waiters -= 1;
        if ( job.waiters <= 0 && !job.started && !job.cancelled ) {
          job.cancelled = true;
          jobs.delete( job.key );
          job.resolve( null );
        }
      }
    },
  };
};

// Moves the photos actually on screen to the front of the queue. Cells mount
// in index order and the queue is LIFO, so the cell mounted last — far below
// the fold, since the grid mounts well past the viewport — is generated first
// and the row the user is looking at is generated last. Ordering by what's
// visible is what the LIFO queue is for; mount order is a poor stand-in for it.
export const prioritizeDeviceImageThumbnails = (
  uris: string[],
  maxPixel: number,
): void => {
  if ( !ImageCropper?.createThumbnail ) return;
  // Pushed in reverse so the topmost visible photo is the first one popped.
  for ( let i = uris.length - 1; i >= 0; i -= 1 ) {
    if ( !memoryCache.has( cacheKey( uris[i], maxPixel ) ) ) {
      scheduleJob( uris[i], maxPixel, true );
    }
  }
};

// Warms the cache for photos near the viewport at lower priority than the
// cells actually on screen. Uris are enqueued in ascending order of importance
// (the queue is LIFO), so pass the nearest-to-viewport photos last.
export const prefetchDeviceImageThumbnails = (
  uris: string[],
  maxPixel: number,
): void => {
  if ( ImageCropper?.createThumbnail ) {
    uris.forEach( uri => {
      // Prefetches keep their waiter forever: nothing "unmounts" a prefetch,
      // and a warmed cache is exactly what makes scrolling back instant.
      if ( !memoryCache.has( cacheKey( uri, maxPixel ) ) ) {
        scheduleJob( uri, maxPixel, false );
      }
    } );
  }
};

// Generates one thumbnail at prefetch priority and resolves with its uri (null
// if it couldn't be generated). For work that needs the thumbnail file itself
// rather than a cell to draw it in, e.g. running subject detection on it.
export const prefetchDeviceImageThumbnail = (
  uri: string,
  maxPixel: number,
): Promise<string | null> => {
  const key = cacheKey( uri, maxPixel );
  const cached = memoryCache.get( key );
  if ( cached ) return Promise.resolve( cached );
  if ( !ImageCropper?.createThumbnail ) return Promise.resolve( null );
  return scheduleJob( uri, maxPixel, false ).promise;
};

// Returns a small cached thumbnail uri for a device photo, generated off the
// UI thread so photo grids scroll without decoding full-resolution originals.
// Falls back to the original uri where the native generator isn't available
// (e.g. Android), and yields undefined until the thumbnail is ready so the
// caller can show a placeholder rather than the full-resolution image.
const useDeviceImageThumbnail = (
  uri: string | undefined,
  maxPixel: number,
): string | undefined => {
  const available = Boolean( ImageCropper?.createThumbnail );
  const key = uri && available
    ? cacheKey( uri, maxPixel )
    : null;
  const [resolved, setResolved] = useState<{ key: string; uri: string } | null>( null );

  useEffect( ( ) => {
    // A cached thumbnail is picked up during render, so there's nothing to
    // wait for and no state to set here.
    if ( !uri || !key || memoryCache.has( key ) ) return ( ) => {};
    let cancelled = false;
    const request = requestDeviceImageThumbnail( uri, maxPixel );
    request.promise.then( result => {
      // Fall back to the original uri if generation failed, so the cell shows
      // the photo (full-res) rather than staying blank forever.
      if ( !cancelled ) setResolved( { key, uri: result ?? uri } );
    } );
    return ( ) => {
      cancelled = true;
      request.release( );
    };
  }, [key, maxPixel, uri] );

  if ( !key ) {
    // No uri at all, or no native generator (e.g. Android): use the original.
    return uri;
  }
  // Read the cache during render rather than waiting for the effect, so a
  // recycled cell shows its photo on the first frame instead of flashing a
  // placeholder (or worse, the previous cell's photo) on the way back.
  return memoryCache.get( key )
    ?? ( resolved?.key === key
      ? resolved.uri
      : undefined );
};

export default useDeviceImageThumbnail;
