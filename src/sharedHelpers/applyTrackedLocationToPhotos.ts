import * as Exify from "@lodev09/react-native-exify";
import { NativeModules, Platform } from "react-native";
import type Realm from "realm";
import Observation from "realmModels/Observation";
import Photo from "realmModels/Photo";
import type { RealmObservation, RealmObservationPojo } from "realmModels/types";
import {
  lookupImportedPhotoDeviceUri,
  normalizeDevicePhotoUri,
} from "sharedHelpers/getOriginalDevicePhotoUri";
import type { TrackedPoint } from "sharedHelpers/interpolateTrackedLocation";
import {
  filterUsableTrackedPoints,
  interpolateFromUsablePoints,
} from "sharedHelpers/interpolateTrackedLocation";
import { drainTrackedLocationFixes } from "sharedHelpers/locationHistoryTracker";
import { log } from "sharedHelpers/logger";
import { privacyZoneGeoprivacy } from "sharedHelpers/privacyZone";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import useStore from "stores/useStore";

const logger = log.extend( "applyTrackedLocationToPhotos" );

export interface TrackedLocationMatch {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  placeGuess?: string | null;
}

const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    updateAssetLocation: ( phUri: string, latitude: number, longitude: number ) => Promise<boolean>;
    updateAssetLocations?: (
      updates: { phUri: string; latitude: number; longitude: number }[]
    ) => Promise<{ updated: number; requested: number }>;
  };
};

const withTimeout = <T, >( promise: Promise<T>, ms: number, label: string ): Promise<T> => (
  new Promise<T>( ( resolve, reject ) => {
    const timer = setTimeout(
      ( ) => reject( new Error( `${label} timed out after ${ms}ms` ) ),
      ms,
    );
    promise
      .then( value => {
        clearTimeout( timer );
        resolve( value );
      } )
      .catch( error => {
        clearTimeout( timer );
        reject( error );
      } );
  } )
);

// Whether the Photos library accepts writes is a device-wide condition, but it
// is discovered once per photo: a single wedged library turned into 156 near
// identical log lines (one remote write each) across two bursts. Report the
// first of a burst and then a running count, rather than every photo.
const SUPPRESSION_WINDOW_MS = 60_000;
const suppressed: Record<string, { count: number; lastLoggedAt: number }> = {};

const reportSuppressed = ( kind: "skipped" | "failed", detail: string ) => {
  const state = suppressed[kind] ?? { count: 0, lastLoggedAt: 0 };
  state.count += 1;
  suppressed[kind] = state;
  if ( Date.now( ) - state.lastLoggedAt < SUPPRESSION_WINDOW_MS ) return;
  const verb = kind === "skipped"
    ? "Skipped"
    : "Failed";
  logger.warn(
    `${verb} updateAssetLocation for ${state.count} photo(s) in the last minute: ${detail}`,
  );
  state.lastLoggedAt = Date.now( );
  state.count = 0;
};

// An asset the user is about to have deleted doesn't need its GPS filled in
// first. Both import paths queue the originals for deletion in the store
// (`pendingGroupPhotoDeletionUris` from Group Photos and the crop editor,
// `removedOriginalDevicePhotoUris` from the obs-create flow), and the deletion
// runs seconds after the save. Writing to those assets is not just wasted
// work: each write is its own PHPhotoLibrary transaction, so a 101-photo
// import fired ~101 library writes in the moments before the deletion that
// then hung. Skipping them removes that burst from the window where the
// confirmation machinery wedges — see promptDeleteOriginalDevicePhotos.ts.
//
// Normalizing both queues per photo is O(n²) over an import, so cache the set
// against the store arrays that produced it; both are replaced immutably on
// every add, so a reference match means nothing has been queued since.
let deletionUriCache: {
  pending: string[];
  removed: string[];
  set: Set<string>;
} | null = null;

const isQueuedForDeletion = ( phUri: string ): boolean => {
  const { pendingGroupPhotoDeletionUris, removedOriginalDevicePhotoUris } = useStore.getState( );
  if (
    deletionUriCache?.pending !== pendingGroupPhotoDeletionUris
    || deletionUriCache?.removed !== removedOriginalDevicePhotoUris
  ) {
    deletionUriCache = {
      pending: pendingGroupPhotoDeletionUris,
      removed: removedOriginalDevicePhotoUris,
      set: new Set(
        [...pendingGroupPhotoDeletionUris, ...removedOriginalDevicePhotoUris]
          .map( uri => normalizeDevicePhotoUri( uri ) )
          .filter( ( uri ): uri is string => !!uri ),
      ),
    };
  }
  return deletionUriCache.set.has( phUri );
};

// Coalesces the per-photo location writes an import produces into one native
// call. Every caller below runs inside a Promise.all, so the whole burst
// arrives within a tick or two; collecting it and applying every change
// request inside a single PHPhotoLibrary.performChanges turns N transactions
// (and N chances for iOS to fail to present its confirmation) into one.
interface PendingLocationWrite {
  phUri: string;
  latitude: number;
  longitude: number;
  resolve: ( ) => void;
}
const COALESCE_WINDOW_MS = 250;

// A bulk import outruns that window. Each observation only queues its write
// after awaiting an EXIF write per photo, and those settle at wildly different
// times across a hundred photos, so the writes trickle in over seconds: the
// first few flush together and every straggler afterwards starts a new batch —
// a new transaction, and a new iOS consent alert. A caller that knows the whole
// set (an import) brackets it instead, and gets exactly one transaction for the
// lot however long the photos take to trickle through.
let locationWriteBatchDepth = 0;

// Native Photos-library writes can trigger a system confirmation dialog that
// silently never presents under certain modal states, leaving the native
// promise unresolved forever (see ImageCropper.m). That's a native-side bug
// worth fixing at the source, but this timeout is the backstop that keeps a
// stuck native call from hanging the UI (e.g. the LocationHistory screen's
// "Apply Tracked Location" button spinner) indefinitely regardless.
//
// Batching means one confirmation for the whole import rather than one per
// photo, so the wait now includes a human deciding to tap it — the old 15s was
// a timeout on a dialog nobody had to answer. Still bounded, because a
// genuinely wedged write holds the shared queue (and the deletion behind it)
// until it gives up.
const BATCH_UPDATE_TIMEOUT_MS = 45_000;

let pendingLocationWrites: PendingLocationWrite[] = [];
let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

const flushLocationWrites = async ( ) => {
  const batch = pendingLocationWrites;
  pendingLocationWrites = [];
  coalesceTimer = null;
  if ( batch.length === 0 ) return;
  const updates = batch.map( ( { phUri, latitude, longitude } ) => (
    { phUri, latitude, longitude }
  ) );
  try {
    // Serialized with deletions (and other location updates) so only one
    // native Photos-library write is ever in flight — see
    // enqueuePhotoLibraryWrite in promptDeleteOriginalDevicePhotos.ts.
    await enqueuePhotoLibraryWrite( ( ): Promise<unknown> => withTimeout<unknown>(
      ImageCropper?.updateAssetLocations
        ? ImageCropper.updateAssetLocations( updates )
        // Older builds without the batched native method still work, one
        // transaction per photo.
        : Promise.all( updates.map( u => ImageCropper?.updateAssetLocation(
          u.phUri,
          u.latitude,
          u.longitude,
        ) ) ),
      BATCH_UPDATE_TIMEOUT_MS,
      `updateAssetLocations for ${updates.length} photo(s)`,
    ) );
  } catch ( error ) {
    reportSuppressed( "failed", String( error instanceof Error
      ? error.message
      : error ) );
  }
  // Best-effort: callers only await this to keep the save from racing ahead of
  // the write, so a failed batch settles the same way a failed write did.
  batch.forEach( write => write.resolve( ) );
};

export const beginLocationWriteBatch = ( ) => { locationWriteBatchDepth += 1; };

// Flushes everything the bracketed work queued, as one transaction. Awaited by
// the caller, which is why a batched write doesn't have to be awaited where it
// is queued (see applyLocationToDevicePhotoLibrary): a queued write that only
// settled on flush, awaited by the very loop whose completion triggers the
// flush, would deadlock.
export const endLocationWriteBatch = async ( ) => {
  locationWriteBatchDepth = Math.max( 0, locationWriteBatchDepth - 1 );
  if ( locationWriteBatchDepth > 0 ) return;
  if ( coalesceTimer ) {
    clearTimeout( coalesceTimer );
    coalesceTimer = null;
  }
  await flushLocationWrites( );
};

// Best-effort: also fills in the location metadata on the original Photos
// library asset (if we know its ph:// identifier), so tracked-location is
// reflected in the Photos app, not just the app's own copy. The native side
// only applies to assets that are missing location, leaving photos that
// already carry their own GPS data untouched.
const applyLocationToDevicePhotoLibrary = async (
  originalDevicePhotoUri: string | null | undefined,
  match: TrackedLocationMatch,
): Promise<void> => {
  const phUri = normalizeDevicePhotoUri( originalDevicePhotoUri );
  if ( Platform.OS !== "ios" || !phUri?.startsWith( "ph://" ) || !ImageCropper ) {
    return;
  }
  if ( isQueuedForDeletion( phUri ) ) {
    reportSuppressed( "skipped", "photo is queued for deletion after import" );
    return;
  }
  if ( locationWriteBatchDepth > 0 ) {
    // Held until the bracketing caller closes the batch, so a hundred photos
    // arriving over several seconds still make one transaction. Nothing waits
    // on it here — endLocationWriteBatch is what the caller awaits.
    pendingLocationWrites.push( {
      phUri,
      latitude: match.latitude,
      longitude: match.longitude,
      resolve: ( ) => {},
    } );
    return;
  }
  await new Promise<void>( resolve => {
    pendingLocationWrites.push( {
      phUri,
      latitude: match.latitude,
      longitude: match.longitude,
      resolve,
    } );
    if ( !coalesceTimer ) {
      coalesceTimer = setTimeout( ( ) => { void flushLocationWrites( ); }, COALESCE_WINDOW_MS );
    }
  } );
};

const toGpsExifTags = ( { latitude, longitude, accuracy }: TrackedLocationMatch ) => ( {
  GPSLatitude: Math.abs( latitude ),
  GPSLatitudeRef: latitude >= 0
    ? "N"
    : "S",
  GPSLongitude: Math.abs( longitude ),
  GPSLongitudeRef: longitude >= 0
    ? "E"
    : "W",
  ...( accuracy != null
    ? { GPSHPositioningError: accuracy }
    : {} ),
} );

// Updates an observation's location to the matched coordinates and, as a
// best-effort side effect, writes the matching GPS data into any local photo
// files (and their originating Photos library assets). Remote-only
// observations have no local files to write, but their coordinates are still
// updated. Returns whether the observation was updated.
const applyTrackedLocationToObservation = async (
  realm: Realm,
  observation: RealmObservation,
  match: TrackedLocationMatch,
): Promise<boolean> => {
  const observationPhotos = observation.observationPhotos ?? [];
  const localUris = observationPhotos
    .map( op => Photo.getLocalPhotoUri( op.photo?.localFilePath ) )
    .filter( ( uri ): uri is string => !!uri );

  // Best-effort EXIF + Photos library updates for any local photo files.
  if ( localUris.length > 0 ) {
    const tags = toGpsExifTags( match );
    try {
      await Promise.all( localUris.map( uri => Exify.write( uri, tags ) ) );
    } catch ( error ) {
      logger.error( "Failed to write EXIF GPS data", error );
    }

    const { importedPhotoDeviceUriByLocalUri } = useStore.getState( );
    await Promise.all( observationPhotos.map( op => {
      const localUri = Photo.getLocalPhotoUri( op.photo?.localFilePath );
      const devicePhotoUri = normalizeDevicePhotoUri( op.originalDevicePhotoUri )
        ?? lookupImportedPhotoDeviceUri( importedPhotoDeviceUriByLocalUri, localUri );
      return applyLocationToDevicePhotoLibrary( devicePhotoUri, match );
    } ) );
  }

  const mutableObservation = observation as RealmObservation & {
    _updated_at?: Date;
    needs_sync?: boolean;
    geoprivacy?: string;
  };

  // The observation only gets a location here, after it was saved, so the
  // privacy zone has to be re-checked against the location being applied.
  const zoneGeoprivacy = privacyZoneGeoprivacy( {
    latitude: match.latitude,
    longitude: match.longitude,
    geoprivacy: observation.geoprivacy,
  } );

  safeRealmWrite( realm, ( ) => {
    mutableObservation.latitude = match.latitude;
    mutableObservation.longitude = match.longitude;
    if ( zoneGeoprivacy ) {
      mutableObservation.geoprivacy = zoneGeoprivacy;
    }
    if ( match.accuracy != null ) {
      mutableObservation.positional_accuracy = match.accuracy;
    }
    if ( match.placeGuess != null ) {
      mutableObservation.place_guess = match.placeGuess;
    }
    mutableObservation._updated_at = new Date( );
    mutableObservation.needs_sync = true;
  }, "applying tracked location to observation" );

  return true;
};

// Auto-fills an observation's location from tracked location history when it
// has no location of its own (i.e. its photos carried no GPS EXIF data). Used
// on import/save so a tracked location is applied automatically to both the
// observation and its Photos library assets. No-ops when the observation
// already has a location, when it has no timestamp to match against, when
// tracking recorded no fixes, or when no fix falls within the match window of
// the observation's time. Returns whether a location was applied.
//
// `precomputedUsablePoints` lets a caller importing many observations at once
// filter the (potentially large) point history a single time and reuse it,
// rather than re-filtering per observation. Callers with a single observation
// can omit it.
export const autoApplyTrackedLocationIfMissing = async (
  realm: Realm,
  observation: RealmObservation,
  precomputedUsablePoints?: TrackedPoint[],
): Promise<boolean> => {
  // An observation that already has a location is the ordinary case — this
  // fired 556 times in five days, carrying the user's coordinates into a shared
  // log to report that nothing happened.
  if ( observation.latitude != null && observation.longitude != null ) {
    return false;
  }

  const observedOn = observation.observed_on_string ?? observation.observed_on;
  if ( !observedOn ) {
    logger.info( `No timestamp on observation ${observation.uuid}; skipping tracked location` );
    return false;
  }

  const usablePoints = precomputedUsablePoints ?? filterUsableTrackedPoints(
    realm.objects( "LocationHistoryPoint" ).sorted( "recordedAt" ),
  );
  if ( usablePoints.length === 0 ) {
    logger.info( "No usable tracked location points recorded; skipping tracked location" );
    return false;
  }

  const trackedLocation = interpolateFromUsablePoints(
    usablePoints,
    new Date( observedOn ).getTime(),
  );
  if ( !trackedLocation ) {
    logger.info(
      `No tracked location within match window of ${observedOn} `
      + `for observation ${observation.uuid}`,
    );
    return false;
  }

  const applied = await applyTrackedLocationToObservation( realm, observation, trackedLocation );

  // Confirm the write actually stuck by reading the field back: this is the one
  // place we can directly catch a later write (a stale save, a remote upsert)
  // clobbering it back to null. The successful case is already covered by the
  // "Auto-filling tracked location" summary the caller logs, so only the
  // clobber — the thing worth waking up to — gets a line of its own.
  const confirmed = realm.objectForPrimaryKey<RealmObservation>( "Observation", observation.uuid );
  if ( applied && confirmed?.latitude == null ) {
    logger.warn(
      `Tracked location did not stick for observation ${observation.uuid}: `
      + "read back as null immediately after the write",
    );
  }

  return applied;
};

// Saves each observation, then auto-fills tracked location for any that ended
// up without one, reusing a single accuracy-filtered point set across all of
// them. Shared by every place that persists freshly-created observations, so
// the location auto-fill can't drift out of sync between call sites the way
// it has twice before (see git history on this file). Returns a map of uuid
// to the location that was applied, for callers that need to mirror the fill
// back onto their own in-memory copies (e.g. for a CV prefetch cache key).
export const saveObservationsAndApplyTrackedLocation = async (
  observations: RealmObservationPojo[],
  realm: Realm,
): Promise<Record<string, TrackedLocationMatch>> => {
  const saveResults = await Promise.allSettled(
    observations.map( obs => Observation.saveLocalObservationForUpload( obs, realm ) ),
  );
  saveResults.forEach( ( result, idx ) => {
    if ( result.status === "rejected" ) {
      logger.error(
        `Failed to save observation ${observations[idx]?.uuid}`,
        result.reason,
      );
    }
  } );

  const trackedLocationByUuid: Record<string, TrackedLocationMatch> = {};
  try {
    const missingLocationObs = observations
      .filter( obs => obs.latitude == null || obs.longitude == null );
    if ( missingLocationObs.length > 0 ) {
      // The newest fixes may still be sitting in the native buffer waiting for
      // the tracker's drain timer, and they're the ones most likely to match a
      // photo the user just took.
      await drainTrackedLocationFixes( realm );
      // Filter the (potentially large) point history once and reuse it for
      // every observation, rather than re-filtering per observation.
      const usablePoints = filterUsableTrackedPoints(
        realm.objects( "LocationHistoryPoint" ).sorted( "recordedAt" ),
      );
      logger.info(
        `Auto-filling tracked location: ${missingLocationObs.length} observation(s) `
        + `missing location, ${usablePoints.length} usable tracked point(s)`,
      );
      // One transaction — and so one iOS consent alert — for the whole set,
      // however long its photos take to work through the EXIF write above.
      beginLocationWriteBatch( );
      try {
        await Promise.all( missingLocationObs.map( async obs => {
          try {
            const savedObs = realm.objectForPrimaryKey<RealmObservation>(
              "Observation",
              obs.uuid,
            );
            if ( !savedObs ) return;
            const applied = await autoApplyTrackedLocationIfMissing(
              realm,
              savedObs,
              usablePoints,
            );
            if ( applied ) {
              trackedLocationByUuid[obs.uuid] = {
                latitude: savedObs.latitude as number,
                longitude: savedObs.longitude as number,
                accuracy: savedObs.positional_accuracy ?? null,
              };
            }
          } catch ( error ) {
            logger.error( `Failed to auto-apply tracked location to ${obs.uuid}`, error );
          }
        } ) );
      } finally {
        await endLocationWriteBatch( );
      }
    }
  } catch ( error ) {
    logger.error( "Failed to auto-apply tracked location while saving observations", error );
  }

  return trackedLocationByUuid;
};

export default applyTrackedLocationToObservation;
