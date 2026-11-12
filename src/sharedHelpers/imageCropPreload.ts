import { exists } from "@dr.pogodin/react-native-fs";
import { cropSourcesPath } from "appConstants/paths";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import {
  clearPersistedPreloads,
  deletePersistedPreload,
  readPersistedPreloads,
  writePersistedPreload,
} from "sharedHelpers/persistedPreloads";
import type { PreparedSourceFile } from "sharedHelpers/prepareCropSource";
import prepareCropSource from "sharedHelpers/prepareCropSource";
import stripFilePrefix from "sharedHelpers/stripFilePrefix";
import { getTunable } from "sharedHelpers/tunableParams";
import { unlink } from "sharedHelpers/util";

// What each stage of a preload cost, and when it finished. The wait between
// photos in a bulk crop is whatever is left of this when the user advances, so
// the editor reports it (crop_photo_slow) rather than leaving the wait as one
// opaque number.
interface PreloadTiming {
  // When the preload was first asked for. Against when the editor showed the
  // photo, this says whether the lookahead reached it in time at all, as
  // opposed to reaching it and being too slow.
  requestedAt: number;
  // How long it waited in the JS queue (behind other photos' preloads) before
  // its export started.
  queuedMs: number;
  exportMs: number;
  prepareMs: number;
  finishedAt: number;
  stageMs?: Record<string, number>;
  source?: PreparedSourceFile;
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

// How many photos are kept prepared for cropping (Settings > Tunable
// Parameters): the next ones in the current bulk crop, the first ones in Group
// Photos, and the ones the photo picker opens on (keepCropPreloads,
// pickerCropPreload). Preloads leave their result on disk, so a deeper
// lookahead costs no extra memory: it banks prepares while the user frames a
// slow crop, to cover a later run of quick ones.
export const PRELOAD_LOOKAHEAD = getTunable( "cropPreloadAhead" );

// A preload not used within this long (Settings > Tunable Parameters, media
// cache lifetime) is dropped at the next launch, files and all.
const PERSISTED_PRELOAD_TTL_MS = getTunable( "mediaCacheDays" ) * 24 * 60 * 60 * 1000;

// Every finished preload, kept on disk as well (persistedPreloads) so the
// work survives navigation.replace cycles, the tab tree being torn down, and
// the app being killed or restarted.
class PersistedPreloadCache extends Map<string, PreloadResult> {
  set( imageUri: string, result: PreloadResult ) {
    writePersistedPreload( imageUri, { ...result, savedAt: Date.now( ) } );
    return super.set( imageUri, result );
  }

  delete( imageUri: string ) {
    deletePersistedPreload( imageUri );
    return super.delete( imageUri );
  }

  clear( ) {
    clearPersistedPreloads( );
    super.clear( );
  }

  // Back into memory without writing it again
  restore( imageUri: string, result: PreloadResult ) {
    super.set( imageUri, result );
  }
}

export const preloadCache = new PersistedPreloadCache( );
// Track in-flight loads by their promise so callers can await (and dedupe)
// an ongoing preload instead of kicking off duplicate, contending work.
const preloadInFlight = new Map<string, Promise<PreloadResult | null>>( );

// Writes the file a preload decodes, where the default export
// (ensureLocalImageForCrop) isn't the one wanted.
export type PreloadExport = ( ) => Promise<string>;

const fileExists = ( uri: string ) => exists( stripFilePrefix( uri ) ).catch( ( ) => false );

// Last launch's preloads, back in the cache once their files are confirmed
// still there. One that has gone unused too long is dropped with its files.
async function restorePersistedPreloads( ) {
  await Promise.all( readPersistedPreloads( ).map( async ( [imageUri, persisted] ) => {
    const { savedAt, ...result } = persisted;
    if ( Date.now( ) - savedAt > PERSISTED_PRELOAD_TTL_MS ) {
      // eslint-disable-next-line no-use-before-define
      releaseCropSource( imageUri, [result.localUri, result.displayUri] );
      return;
    }
    const [hasSource, hasDisplay] = await Promise.all( [
      fileExists( result.localUri ),
      fileExists( result.displayUri ),
    ] );
    if ( hasSource && hasDisplay ) {
      preloadCache.restore( imageUri, result as PreloadResult );
    } else {
      // eslint-disable-next-line no-use-before-define
      releaseCropSource( imageUri, [result.localUri, result.displayUri] );
    }
  } ) ).catch( ( ) => undefined );
}
const restored = restorePersistedPreloads( );

async function loadImageData(
  imageUri: string,
  cropSourceUri: string,
  existingSavedCrop: NormalizedCrop | null,
  requestedAt: number,
  exportSource?: PreloadExport,
): Promise<PreloadResult | null> {
  // A preload asked for in the moments after launch may be one of last
  // launch's, still being read back.
  await restored;
  const kept = preloadCache.get( imageUri );
  if ( kept ) return kept;
  const startedAt = Date.now( );
  const resolvedUri = exportSource
    ? await exportSource( )
    : await ensureLocalImageForCrop( cropSourceUri, "original" );
  const exportedAt = Date.now( );
  // One decode of the photo, off the screen the user is still cropping on,
  // producing the size, the framing and the file the cropper will draw.
  const prepared = await prepareCropSource( imageUri, resolvedUri, existingSavedCrop );
  if ( !prepared ) {
    return null;
  }
  const finishedAt = Date.now( );
  return {
    localUri: resolvedUri,
    displayUri: prepared.displayUri,
    size: prepared.size,
    crop: prepared.crop,
    timing: {
      requestedAt,
      queuedMs: startedAt - requestedAt,
      exportMs: exportedAt - startedAt,
      prepareMs: finishedAt - exportedAt,
      finishedAt,
      stageMs: prepared.stageMs,
      source: prepared.source,
    },
  };
}

// Returns a promise resolving to the preload result. Reuses the module-level
// cache and dedupes concurrent loads for the same imageUri so the same
// expensive asset export + subject detection never runs twice at once.
function preloadImage(
  imageUri: string,
  cropSourceUri: string,
  existingSavedCrop: NormalizedCrop | null,
  requestedAt: number,
  exportSource?: PreloadExport,
): Promise<PreloadResult | null> {
  const cached = preloadCache.get( imageUri );
  if ( cached ) {
    return Promise.resolve( cached );
  }
  const inFlight = preloadInFlight.get( imageUri );
  if ( inFlight ) {
    return inFlight;
  }
  const promise = loadImageData(
    imageUri,
    cropSourceUri,
    existingSavedCrop,
    requestedAt,
    exportSource,
  )
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
  requestedAt: number;
  exportSource?: PreloadExport;
  // Prepared ahead of any crop (pickerCropPreload): only started when nothing
  // a crop is waiting on is queued.
  background: boolean;
  resolve: ( result: PreloadResult | null ) => void;
}

// Each preload runs a heavy native full-resolution decode + subject detection.
// Every load, the photo on screen included, goes through this queue in the
// order it was asked for, this many at a time (Settings > Tunable Parameters).
// The native prepare queue is concurrent, so this is the only limit; camera
// raws are still decoded one at a time under the native raw decode lock.
export const PRELOAD_CONCURRENCY = getTunable( "cropPreloadConcurrency" );
const preloadQueue: PreloadRequest[] = [];
const preloadQueued = new Map<string, Promise<PreloadResult | null>>( );
let activePreloadCount = 0;

function startNextPreload( ) {
  const foreground = preloadQueue.findIndex( queued => !queued.background );
  const [request] = preloadQueue.splice( Math.max( foreground, 0 ), 1 );
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
    request.requestedAt,
    request.exportSource,
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
// A background preload (photos prepared before they are picked) runs only when
// nothing else is queued; asking for one in the foreground promotes it.
export function enqueuePreload(
  imageUri: string,
  cropSourceUri: string,
  existingSavedCrop: NormalizedCrop | null,
  { exportSource, background = false }: {
    exportSource?: PreloadExport;
    background?: boolean;
  } = {},
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
    // eslint-disable-next-line no-use-before-define
    if ( !background ) promotePreloads( [imageUri] );
    return queued;
  }
  let resolve: ( result: PreloadResult | null ) => void = ( ) => {};
  const promise = new Promise<PreloadResult | null>( res => {
    resolve = res;
  } );
  preloadQueued.set( imageUri, promise );
  preloadQueue.push( {
    imageUri,
    cropSourceUri,
    existingSavedCrop,
    requestedAt: Date.now( ),
    exportSource,
    background,
    resolve,
  } );
  pumpPreloadQueue( );
  return promise;
}

// Background preloads of photos the user has now picked, which the cropper is
// about to wait on, move into the foreground, in the order they were queued.
export function promotePreloads( imageUris: Iterable<string> ) {
  const uris = new Set( imageUris );
  preloadQueue.forEach( request => {
    if ( uris.has( request.imageUri ) ) request.background = false;
  } );
}

// A photo the import copied to a new uri (a USB-staged photo copied into the
// gallery folder on Done) keeps the preload started on its old uri: the bytes
// are the same, so the cropper finds it under the new one instead of starting
// over.
export function aliasPreload( fromUri: string, toUri: string ) {
  if ( fromUri === toUri || preloadCache.has( toUri ) || preloadInFlight.has( toUri ) ) {
    return;
  }
  const cached = preloadCache.get( fromUri );
  const pending = cached
    ? Promise.resolve( cached )
    : preloadInFlight.get( fromUri ) ?? preloadQueued.get( fromUri );
  if ( !pending ) {
    return;
  }
  const promise = pending.then( result => {
    preloadCache.delete( fromUri );
    if ( !result ) {
      return null;
    }
    const aliased = { ...result, localUri: toUri };
    preloadCache.set( toUri, aliased );
    // The file the preload decoded is superseded by the copy at toUri, which
    // holds the same bytes. Only a scratch export is removed, never a staged
    // USB original.
    // eslint-disable-next-line no-use-before-define
    if ( result.localUri !== toUri ) releaseCropSource( fromUri, [result.localUri] );
    return aliased;
  } ).finally( ( ) => {
    preloadInFlight.delete( toUri );
  } );
  preloadInFlight.set( toUri, promise );
}

// Once a photo is cropped, the export and display file it was cropped from
// have served their purpose (the original is copied to photoUploads), so drop
// them instead of leaving full-size copies in cropSourcesPath.
export function releaseCropSource( imageUri: string, uris: ( string | null )[] ) {
  preloadCache.delete( imageUri );
  uris
    .map( uri => uri && stripFilePrefix( uri ) )
    .filter( path => path?.startsWith( `${cropSourcesPath}/` ) )
    .forEach( path => { unlink( path ).catch( ( ) => {} ); } );
}

// When the user asked for a bulk crop (Done in the photo picker, or crop in
// Group Photos), so the editor can report the first photo's wait from the tap,
// the copy out of the library included, not just from when its file landed.
let cropRequestedAt = 0;
export function noteCropRequested( ) {
  cropRequestedAt = Date.now( );
}
export function takeCropRequestedAt( ): number {
  const at = cropRequestedAt;
  cropRequestedAt = 0;
  return at;
}
