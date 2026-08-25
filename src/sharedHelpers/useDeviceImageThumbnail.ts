import { exists, mkdir, stat } from "@dr.pogodin/react-native-fs";
import { deviceThumbnailsPath } from "appConstants/paths";
import { useEffect, useState } from "react";
import { NativeModules } from "react-native";
import { fileExtension } from "sharedHelpers/importedFileTypes";
import { log } from "sharedHelpers/logger";
import { unlink } from "sharedHelpers/util";

const logger = log.extend( "useDeviceImageThumbnail" );

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
// that fix kept getting served). v6: tile-sized thumbnails of a ph:// asset
// were square-cropped (PHImageContentModeAspectFill) and are now the whole
// frame, so anything cached under v5 describes a different frame than the
// photo it stands for.
const CACHE_VERSION = 6;

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

// ImageCropper.m's native side switches to a network-allowed, high-quality
// decode at this same threshold (see highQualityDecode in createThumbnail) so
// the Group Photos crop overlay can pull the real original from iCloud rather
// than settle for whatever soft local rendition is already cached.
const HIGH_QUALITY_MIN_PIXEL = 8192;

const isHighQuality = ( job: Job ) => job.maxPixel >= HIGH_QUALITY_MIN_PIXEL;

// How many high-quality decodes may run at once, out of MAX_CONCURRENCY. One
// of these holds a full-resolution frame in memory (a 6960x4640 camera photo
// is ~129MB) on top of whatever the decoder needs to get there, which for a
// RAW original is a demosaic of the whole sensor image. Four at a time is what
// separates the import that produced undecodable thumbnails from the same
// photos decoding fine when they were walked one at a time.
const MAX_HIGH_QUALITY_CONCURRENCY = 1;

const jobs = new Map<string, Job>( );
// Pending work is served last-in-first-out, and visible cells jump ahead of
// prefetches. A queue served in request order is what made scrolling back feel
// like previews had "unloaded": the thumbnails for the rows now on screen sat
// behind a backlog of requests from every row already scrolled past.
const visibleStack: Job[] = [];
const prefetchStack: Job[] = [];
let active = 0;
let activeHighQuality = 0;

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
    // High-quality jobs passed over because one is already running. They stay
    // queued — and go back in the order they were queued in — rather than
    // being dropped or made to wait for the whole stack to drain.
    const deferred: Job[] = [];
    while ( !next && stack.length > 0 ) {
      // A job can appear in a stack more than once (requested again, or
      // promoted from prefetch to visible); started/cancelled skips the dupes.
      const job = stack.pop( ) as Job;
      if ( !job.started && !job.cancelled ) {
        if ( isHighQuality( job ) && activeHighQuality >= MAX_HIGH_QUALITY_CONCURRENCY ) {
          deferred.push( job );
        } else {
          next = job;
        }
      }
    }
    for ( let j = deferred.length - 1; j >= 0; j -= 1 ) {
      stack.push( deferred[j] );
    }
  }
  return next;
};

// A native generation that never settles must not hold a concurrency slot for
// the life of the process: four of those wedge the queue and every remaining
// cell stays blank forever. Giving up frees the slot and leaves the cell to
// display the original uri instead.
const GENERATION_TIMEOUT_MS = 15000;

// A high-quality decode can take tens of seconds (it is allowed to pull the
// original down from iCloud), well past GENERATION_TIMEOUT_MS -- and once the
// JS side times out, the result is discarded even if the native call later
// succeeds, so the cell fell back to a soft direct ph:// load forever.
const HIGH_QUALITY_GENERATION_TIMEOUT_MS = 120000;

// Distinguishes a timeout from a genuine result so the caller can log which
// one happened -- both used to just come back as null, which made a timed-out
// high-quality decode indistinguishable from one that legitimately failed.
const raceWithTimeout = (
  promise: Promise<string>,
  maxPixel: number,
): Promise<{ value: string | null; timedOut: boolean }> => {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutMs = maxPixel >= HIGH_QUALITY_MIN_PIXEL
    ? HIGH_QUALITY_GENERATION_TIMEOUT_MS
    : GENERATION_TIMEOUT_MS;
  return Promise.race( [
    promise.then( value => ( { value, timedOut: false } ) ),
    new Promise<{ value: null; timedOut: true }>( resolve => {
      timer = setTimeout( ( ) => resolve( { value: null, timedOut: true } ), timeoutMs );
    } ),
  ] ).finally( ( ) => clearTimeout( timer ) );
};

// Keys already reported as ungeneratable. Nothing caches a failure, so every
// pass back through a grid retries it and logged it again: one deleted photo
// accounted for 39 identical warnings, and a single import filled the log with
// over a thousand. The first report per photo and size is the diagnostic.
const loggedFailures = new Set<string>( );

// That still leaves a whole import of photos the decoder cannot read, each one
// a distinct key and so a distinct warning — 1,137 of the 3,000 entries in the
// Aug 6-19 app log, every one a .CR3, and every one a network POST. The first
// few of a kind carry the detail; after that a rolling total is all the extra
// POSTs can add.
const MAX_DETAILED_FAILURES_PER_TYPE = 3;
const FAILURE_SUMMARY_EVERY = 100;
const failuresByType = new Map<string, number>( );
let totalFailures = 0;

const recordFailure = ( uri: string ): { detailed: boolean; summarize: boolean } => {
  const type = fileExtension( uri );
  const count = ( failuresByType.get( type ) ?? 0 ) + 1;
  failuresByType.set( type, count );
  totalFailures += 1;
  return {
    detailed: count <= MAX_DETAILED_FAILURES_PER_TYPE,
    summarize: totalFailures % FAILURE_SUMMARY_EVERY === 0,
  };
};

const failureTypeCounts = ( ) => Array.from( failuresByType.entries( ) )
  .sort( ( a, b ) => b[1] - a[1] )
  .map( ( [type, count] ) => `${type}:${count}` )
  .join( " " );

const runJob = async ( job: Job ) => {
  let result: string | null = null;
  const highQuality = isHighQuality( job );
  const start = Date.now( );
  try {
    await ensureDir( );
    const outputPath = `${deviceThumbnailsPath}/${hashKey( job.key )}.jpg`;
    if ( await exists( outputPath ) ) {
      result = `file://${outputPath}`;
    } else {
      const { value, timedOut } = await raceWithTimeout(
        ImageCropper!.createThumbnail( job.uri, job.maxPixel, outputPath ),
        job.maxPixel,
      );
      if ( timedOut && highQuality ) {
        logger.warn(
          `createThumbnail timed out after ${Date.now( ) - start}ms for ${job.uri}, `
          + `maxPixel=${job.maxPixel}`,
        );
      }
      result = value || null;
    }
  } catch ( e ) {
    // Logged whatever the size: generation now rejects an encode that wouldn't
    // decode (see encodedThumbnailData in ImageCropper.m), and a photo that
    // can't produce a thumbnail at all is worth knowing about at any size.
    if ( !loggedFailures.has( job.key ) ) {
      loggedFailures.add( job.key );
      const { detailed, summarize } = recordFailure( job.uri );
      if ( detailed ) {
        logger.warn(
          `createThumbnail failed after ${Date.now( ) - start}ms for ${job.uri}, `
          + `maxPixel=${job.maxPixel}: ${e}`,
        );
      } else if ( summarize ) {
        logger.warnWithExtra( "thumbnail_failures", {
          total: totalFailures,
          byType: failureTypeCounts( ),
          lastMaxPixel: job.maxPixel,
        } );
      }
    }
    result = null;
  }
  if ( result ) {
    memoryCache.set( job.key, result );
  }
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
  const highQuality = isHighQuality( job );
  if ( highQuality ) activeHighQuality += 1;
  runJob( job ).then( ( ) => {
    active -= 1;
    if ( highQuality ) activeHighQuality -= 1;
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

// Throws away a generated thumbnail the caller couldn't decode. Generation
// reports success as long as the encode and the write succeeded, so a file
// that holds no usable image still lands in the cache — and once it does, both
// the on-disk cache (a two-day TTL) and the in-memory one keep handing that
// same file to every cell that asks, so the photo can never be drawn. Deleting
// it makes the next request regenerate.
export const invalidateDeviceImageThumbnail = async (
  thumbnailUri: string,
  context: string,
): Promise<void> => {
  const path = thumbnailUri.replace( /^file:\/\//, "" );
  // Only ever deletes files this module generated, never an original photo.
  if ( !path.startsWith( `${deviceThumbnailsPath}/` ) ) return;
  memoryCache.forEach( ( value, key ) => {
    if ( value === thumbnailUri ) memoryCache.delete( key );
  } );
  try {
    // The byte count is the diagnostic: a header-only JPEG is a fixed few
    // hundred bytes whatever photo it came from, which distinguishes a bad
    // encode from a file truncated on the way to disk.
    const { size } = await stat( path );
    logger.warn( `discarding undecodable thumbnail (${size} bytes) for ${context}` );
    await unlink( path );
  } catch ( e ) {
    logger.warn( `could not discard undecodable thumbnail for ${context}: ${e}` );
  }
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
