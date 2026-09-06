import {
  CameraRoll,
  iosRequestReadWriteGalleryPermission,
} from "@react-native-camera-roll/camera-roll";
import i18next from "i18next";
import {
  Alert, AppState, NativeModules, Platform,
} from "react-native";
import { forgetAppCreatedPhotoAssets } from "sharedHelpers/appCreatedPhotoAssets";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "promptDeleteOriginalDevicePhotos" );

// How many Photos-library writes have hung this session.
let photoLibraryWriteHangCount = 0;

// Native helpers (iOS) that (a) report the window/scene/modal state governing
// whether the iOS deletion confirmation can present, and (b) delete after
// dismissing any modal that would block that confirmation.
const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    photoDeletionContext?: ( phUris: string[] ) => Promise<string>;
    photoAssetDiagnostics?: ( phUris: string[] ) => Promise<string>;
    deletePhotoAssets?: ( phUris: string[] ) => Promise<{
      deleted: number;
      requested: number;
      fetched?: number;
      appCreated?: number;
      transactionMs?: number;
      undeletable?: number;
      assets?: string;
    }>;
  };
};

interface DeleteOriginalDevicePhotosOptions {
  userInitiated?: boolean;
}

// What the OS actually did, so callers can tell the user the truth instead of
// assuming every requested URI was deleted. A hung delete resolves normally
// (the error is handled here), so without this a caller can't distinguish
// "deleted 1159 photos" from "deleted none of them".
export interface DeleteOriginalDevicePhotosResult {
  deleted: number;
  requested: number;
  succeeded: boolean;
  // The OS hasn't answered yet and we stopped waiting. Distinct from a failure:
  // the transaction is still open down in PhotoKit and usually still goes
  // through, so a caller should rescan rather than tell the user it went wrong.
  pending?: boolean;
  // Assets PhotoKit refuses to let this app delete (synced from a computer, or
  // in a shared album rather than this library). Nothing is wrong and nothing
  // will change by retrying: they were never sent to a transaction.
  undeletable?: number;
}

const filterDeletableDevicePhotoUris = ( photoUris: string[] ): string[] => (
  [...new Set(
    photoUris
      .map( uri => normalizeDevicePhotoUri( uri ) )
      .filter( ( uri ): uri is string => !!uri ),
  )].filter( uri => {
    if ( Platform.OS === "ios" ) {
      return uri.startsWith( "ph://" );
    }
    return uri.startsWith( "content://" ) || uri.startsWith( "file://" );
  } )
);

// Requests readWrite photo library permission. iOS shows the system dialog
// exactly once (when status is notDetermined); subsequent calls return the
// cached status silently, so this acts as a global one-time grant.
const ensureDeletePhotosPermission = async ( requested: number ): Promise<boolean> => {
  if ( Platform.OS !== "ios" ) {
    return true;
  }
  const status = await iosRequestReadWriteGalleryPermission( );
  // Only worth a line when it isn't the answer we expect: a granted status is
  // implied by the deletion that follows, and logging it on every delete was
  // one remote write per delete for no information.
  if ( status !== "granted" ) {
    logger.info( `photo library readWrite permission status: ${status} (${requested} photo(s))` );
  }
  // "limited" access (the user picked specific photos) still lets us delete
  // those photos — iOS shows its own deletion confirmation — so treat it the
  // same as full access. Rejecting it here silently skipped deletion for the
  // many users who grant limited access.
  return status === "granted" || status === "limited";
};

// iOS presents a single system confirmation per Photos-library write. Firing
// a second write (delete OR location update, see applyTrackedLocationToPhotos.ts)
// while one is still in flight can make both hang (iOS won't present a second
// confirmation over the first), and a burst of concurrent writes can also
// spuriously trip each other's timeout under normal I/O load. Route every
// native Photos-library write (not just deletions) through this single chain
// so only one is ever in flight.
let photoLibraryWriteChain: Promise<void> = Promise.resolve( );

const settled = ( promise: Promise<unknown> ): Promise<void> => promise.then(
  ( ) => undefined,
  ( ) => undefined,
);

// Waits for a native write to settle, but not forever: a task whose native call
// never comes back must not poison the chain for the rest of the session.
const heldUntilSettled = ( promise: Promise<unknown>, ms: number ): Promise<void> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race( [
    settled( promise ),
    new Promise<void>( resolve => { timer = setTimeout( resolve, ms ); } ),
  ] ).then( ( ) => { clearTimeout( timer ); } );
};

// Sits above the native deletion watchdog (kInatPendingDeleteWatchdogSeconds in
// ImageCropper.m), so a native call that is merely slow has always settled
// before the chain stops waiting for it.
const CHAIN_HOLD_MS = 170_000;

export const enqueuePhotoLibraryWrite = <T, >(
  task: ( holdChainUntil: ( nativeWrite: Promise<unknown> ) => void ) => Promise<T>,
): Promise<T> => {
  // The native transaction this task opened, when it tells us about one. A task
  // that gives up on its own native call leaves iOS still holding an open
  // performChanges, and opening a second one behind it is what wedges
  // photolibraryd — the whole point of this chain. So the chain waits on the
  // transaction, not on our patience with it.
  let nativeWrite: Promise<unknown> | undefined;
  const run = photoLibraryWriteChain.then(
    ( ) => task( write => { nativeWrite = write; } ),
  );
  // Keep the chain alive even if this write rejects, so later writes still fire.
  photoLibraryWriteChain = settled( run ).then( ( ) => (
    nativeWrite
      ? heldUntilSettled( nativeWrite, CHAIN_HOLD_MS )
      : undefined
  ) );
  return run;
};

// How long a caller waits on a deletion before we stop holding it there.
//
// This used to be a hard timeout that also decided the outcome: at 10s the
// promise rejected, the caller reported "Something went wrong", and the chain
// above was released. All three were wrong. The native module gives the same
// call 150s and has a PHPhotoLibraryChangeObserver fallback that resolves as
// soon as the assets really vanish, so at 10s the deletion is usually still
// going to happen: the Aug 8 log has a "failed" delete of 112 photos followed a
// minute later by a rescan that found 44. Every deletion that did complete came
// back in 1.3-1.8s, so 15s is well clear of a working one — but past it we stop
// waiting without either calling it a failure or letting go of the native call.
const UI_WAIT_MS = 15_000;

// A PhotoKit transaction costs ~1.6s whatever it holds: 3 assets took 1752ms,
// 19 took 1442ms, 275 consent-free ones took 1691ms, 280 mixed ones 1543ms. A
// deletion issues exactly one, so that cost is its honest duration however many
// photos it carries.
const TRANSACTION_MS_ALLOWANCE = 1800;

// How many photos go into one PhotoKit transaction.
//
// Chunking was retired once, on the reasoning that a hung library hangs a
// one-asset deletion as readily as a 283-asset one — true, but it is about a
// library that has already stopped answering, and it stopped being the whole
// story. Since the single-transaction change on Aug 30 the log splits perfectly
// on size: 280, 83, 83, 67, 61, 60, 60, 37, 35, 26, 15, 14, 9, 8, 8 and 4 all
// deleted, in 1.3-1.8s each, while 932 and 947 have hung six times running,
// across two builds, an iOS point update and several relaunches, never
// presenting a confirmation and never calling back. Nothing above 280 has ever
// worked and nothing at or below it has ever failed.
//
// A transaction is all or nothing, so one asset PhotoKit won't answer for takes
// every photo batched with it down too — which is why 947 photos have been
// stuck at 947 for two days, deleting none of them on every attempt. Chunking
// bounds that whichever way the cause falls: if the size is what does it, all
// of it now goes through, and if instead there is a single bad asset in there,
// the other chunks land and the per-chunk log below says which one to look at.
//
// It costs the user nothing. PhotoKit presents its confirmation once per
// transaction, but only for assets the app didn't create, and these are the
// app's own USB imports — the Sep 4 deletions report appCreated 61 of 61, 83 of
// 83, 67 of 67 — so these chunks ask nothing. A mixed cleanup can ask more than
// once; 200 keeps that to a few, well inside the range that has always worked.
const DELETE_CHUNK_SIZE = 200;

const chunkCount = ( uriCount: number ) => Math.max(
  1,
  Math.ceil( uriCount / DELETE_CHUNK_SIZE ),
);

const chunked = ( uris: string[] ): string[][] => {
  const chunks: string[][] = [];
  for ( let i = 0; i < uris.length; i += DELETE_CHUNK_SIZE ) {
    chunks.push( uris.slice( i, i + DELETE_CHUNK_SIZE ) );
  }
  return chunks;
};

// Chunks run one after another, so the budget is per transaction rather than
// per deletion. Never below the 15s a single one has always had.
const uiWaitMs = ( chunkCount: number ) => Math.max(
  UI_WAIT_MS,
  3000 + ( TRANSACTION_MS_ALLOWANCE * chunkCount ) + 4000,
);

// The pending-delete diagnostic has to land while the delete is still in
// flight, so it stays inside the wait above.
const hangReportMs = ( chunkCount: number ) => Math.min(
  uiWaitMs( chunkCount ) - 2000,
  3000 + ( TRANSACTION_MS_ALLOWANCE * chunkCount ),
);

// Returned by the race below when the OS hasn't answered inside UI_WAIT_MS.
const STILL_PENDING = { stillPending: true } as const;

// The native module refused to open a transaction because the last one it
// opened has never come back (see the write gate in ImageCropper.m). Not a
// failure of this deletion: nothing was attempted, and nothing will be until
// the app is relaunched, so it needs its own report and its own message rather
// than a third copy of "Something went wrong".
const isLibraryBusy = ( error: unknown ): boolean => (
  ( error as { code?: string } | undefined )?.code === "PHOTOS_LIBRARY_BUSY"
);

const performDeleteOriginalDevicePhotos = async (
  photoUris: string[],
  options: DeleteOriginalDevicePhotosOptions = {},
  holdChainUntil: ( nativeWrite: Promise<unknown> ) => void = ( ) => undefined,
): Promise<DeleteOriginalDevicePhotosResult> => {
  const uniqueUris = filterDeletableDevicePhotoUris( photoUris );
  if ( uniqueUris.length === 0 ) {
    if ( photoUris.filter( Boolean ).length > 0 ) {
      logger.warn(
        "Skipped deleting device photos because no deletable URIs were resolved",
        { photoUris },
      );
    }
    return { deleted: 0, requested: 0, succeeded: true };
  }

  const requested = uniqueUris.length;
  const chunks = chunked( uniqueUris );

  const hasPermission = await ensureDeletePhotosPermission( requested );
  if ( !hasPermission ) {
    logger.warn( "Skipped deleting device photos: photo library permission not granted" );
    if ( options.userInitiated ) {
      Alert.alert(
        i18next.t( "Something-went-wrong" ),
        i18next.t( "Could-not-delete-original-photos" ),
      );
    }
    return { deleted: 0, requested, succeeded: false };
  }

  // The ph:// URIs identify the user's photos, say nothing a count doesn't, and
  // made single log lines kilobytes long; the counts below are what a report
  // is read for.
  const startedAt = Date.now( );
  // iOS can only present the deletion confirmation to a foreground app, so a
  // delete that spans a trip to the background is a different failure from one
  // that hangs while the user is watching it.
  //
  // This used to count "inactive" as having left the foreground, and that made
  // the flag useless: the Aug 6 log has three *successful* deletions, and the
  // native context captured before each one says sceneState=1
  // (foregroundInactive). These deletes are issued straight after a navigation
  // or a modal dismissal, so foreground-inactive is the normal state to be in
  // when one starts, not an anomaly — the old flag was true before the delete
  // even began. A whole theory ("a consent alert requested by an app that then
  // leaves the foreground wedges photolibraryd") rested on one hang reporting
  // it. Only "background" is the user actually leaving; "inactive" is recorded
  // separately so nothing is lost. Neither reads anything into iOS's "unknown",
  // which is what it reports early in a launch.
  let backgrounded = AppState.currentState === "background";
  let wentInactive = AppState.currentState === "inactive";
  let appStateChanges = 0;
  const appStateSubscription = AppState.addEventListener( "change", nextState => {
    appStateChanges += 1;
    if ( nextState === "background" ) backgrounded = true;
    if ( nextState === "inactive" ) wentInactive = true;
  } );
  // Populated before the delete starts so a hang report still carries why the
  // confirmation couldn't present (modal in vcChain, no scene…). Logged only
  // when something goes wrong — on the happy path it was pure volume.
  let deletionContext = "not captured";
  const pendingExtra = ( ) => ( {
    requested,
    ms: Date.now( ) - startedAt,
    backgrounded,
    wentInactive,
    appStateChanges,
    appState: typeof AppState.currentState === "string"
      ? AppState.currentState
      : "unknown",
    hangsThisSession: photoLibraryWriteHangCount,
    context: deletionContext,
  } );
  const hangTimer = setTimeout( ( ) => {
    photoLibraryWriteHangCount += 1;
    // Named without the interval: it moved with DELETE_TIMEOUT_MS, and a marker
    // that changes name is a marker whose history stops grouping. `ms` says
    // when it fired. Was photo_delete_pending_20s up to and including build
    // 3ef9032d1.
    logger.errorWithExtra( "photo_delete_pending", pendingExtra( ) );
    // The context above is a snapshot from *before* the delete, so it can't say
    // whether something presented over the app afterwards — and the log's three
    // hangs all showed a foreground app with no modal and every asset fetched,
    // which killed the "the app lost the foreground" explanation without
    // offering another. Re-read it now. photoDeletionContext hops to the main
    // queue, so a request that doesn't come back is itself the answer: the main
    // thread is wedged, and no confirmation could present on it whatever Photos
    // is doing.
    if ( Platform.OS === "ios" && ImageCropper?.photoDeletionContext ) {
      const askedAt = Date.now( );
      let contextRespondedIn = -1;
      void Promise.race( [
        ImageCropper.photoDeletionContext( uniqueUris ).then( context => {
          contextRespondedIn = Date.now( ) - askedAt;
          return context;
        } ),
        new Promise<null>( resolve => { setTimeout( ( ) => resolve( null ), 5000 ); } ),
      ] ).catch( ( ) => null ).then(
        contextAtHang => logger.errorWithExtra( "photo_delete_hang_context", {
          requested,
          mainQueueResponsive: contextAtHang !== null,
          msToRespond: contextRespondedIn,
          contextAtHang: contextAtHang ?? "main queue did not respond in 5000ms",
        } ),
      ).catch( ( ) => undefined );
    }
    // Free disk space used to be measured here, on the theory that a deletion
    // needs room to move assets into Recently Deleted. The log has answered it:
    // the Sep 4 deletions of 61, 15, 83, 67 and 60 photos all landed with 1.8GB
    // free, and the Sep 6 delete of 932 hung with 9.1GB. Free space is not what
    // separates a deletion that works from one that doesn't, so the probe is
    // gone rather than firing on every hang for an answer already given.
    //
    // What the photos themselves are. Every property the log has checked so far
    // says these assets are ordinary and deletable, so the next question is
    // what kind of photo they are — and what device and iOS this is, since the
    // failure arrived on a date rather than with a batch.
    if ( Platform.OS === "ios" && ImageCropper?.photoAssetDiagnostics ) {
      void Promise.race( [
        ImageCropper.photoAssetDiagnostics( uniqueUris ),
        new Promise<null>( resolve => { setTimeout( ( ) => resolve( null ), 5000 ); } ),
      ] ).catch( ( ) => null ).then(
        assetsAtHang => logger.errorWithExtra( "photo_delete_asset_detail", {
          requested,
          assets: assetsAtHang ?? "main queue did not respond in 5000ms",
        } ),
      ).catch( ( ) => undefined );
    }
  }, hangReportMs( chunks.length ) );
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  // What the chunks below have managed between them. Out here because both the
  // late-settling report, which fires after the UI has stopped waiting, and the
  // catch, which sees a chunk that failed after earlier ones landed, have to
  // read it.
  const progress = { deleted: 0, undeletable: 0, done: 0 };
  // Deliberately not a field on `progress`, which gets logged: the ph:// URIs
  // identify the user's photos, say nothing a count doesn't, and made single
  // log lines kilobytes long.
  const cleared: string[] = [];
  try {
    if ( Platform.OS === "ios" && ImageCropper?.photoDeletionContext ) {
      try {
        // Bounded: this hops to the main queue, and a main queue slow enough to
        // sit on it is exactly the condition being diagnosed. Awaiting it
        // unbounded meant the diagnostic could stop the deletion it was there
        // to explain from ever starting.
        deletionContext = await Promise.race( [
          ImageCropper.photoDeletionContext( uniqueUris ),
          new Promise<string>( resolve => {
            setTimeout( ( ) => resolve( "unavailable: main queue busy for 5000ms" ), 5000 );
          } ),
        ] );
      } catch ( ctxError ) {
        deletionContext = `unavailable: ${String( ctxError )}`;
      }
    }

    logger.info(
      `Deleting ${uniqueUris.length} device photo(s)${
        chunks.length > 1
          ? ` in ${chunks.length} transaction(s) of up to ${DELETE_CHUNK_SIZE}`
          : ""}`,
    );
    // Chunks go out one at a time and stop at the first one the library doesn't
    // answer: the next transaction issued at a wedged photolibraryd is the one
    // thing known to make the wedge worse, and by then this deletion has its
    // answer anyway.
    const runChunks = async ( ) => {
      for ( let index = 0; index < chunks.length; index += 1 ) {
        const chunk = chunks[index];
        const chunkStartedAt = Date.now( );
        // Prefer the native path that dismisses a blocking modal before
        // deleting; fall back to CameraRoll on platforms/builds without it.
        const nativeWrite = ( Platform.OS === "ios" && ImageCropper?.deletePhotoAssets )
          ? ImageCropper.deletePhotoAssets( chunk )
          : CameraRoll.deletePhotos( chunk );
        // Whatever we decide below, the next Photos-library write waits for this
        // transaction rather than stacking on top of it.
        holdChainUntil( nativeWrite );
        // eslint-disable-next-line no-await-in-loop
        const chunkResult = await nativeWrite;
        // Report what the OS actually deleted, not what we asked for. A call
        // that resolves with deleted:0 (e.g. fetched:0 — every URI is a ghost
        // pointing at an already-deleted asset) is a no-op, and logging it as a
        // deletion of all N made a repeating no-op look like a working cleanup.
        const chunkDeleted = ( chunkResult as { deleted?: number } | undefined )?.deleted
          ?? chunk.length;
        const chunkUndeletable
          = ( chunkResult as { undeletable?: number } | undefined )?.undeletable ?? 0;
        progress.deleted += chunkDeleted;
        progress.undeletable += chunkUndeletable;
        progress.done = index + 1;
        // A transaction deletes all of its assets or none of them, so anything
        // above zero means these are gone and no longer worth tracking as ours.
        if ( chunkDeleted > 0 ) cleared.push( ...chunk );
        // Photos the app is not allowed to delete. They used to go into the
        // transaction with everything else and take it down with them — a
        // transaction is all or nothing, and PhotoKit answers a request it
        // can't carry out with silence rather than an error. Now they're left
        // out, which makes them the reason a cleanup can't empty, so say so as
        // its own line.
        if ( chunkUndeletable > 0 ) {
          logger.warnWithExtra( "photo_delete_undeletable", {
            undeletable: chunkUndeletable,
            requested: chunk.length,
            deleted: chunkDeleted,
            assets: ( chunkResult as { assets?: string } | undefined )?.assets ?? "unknown",
          } );
        }
        // How long the transaction took, and which of the batch it was. Above
        // the ~1.5s a transaction costs whatever it carries means a human
        // answered a confirmation for it.
        logger.infoWithExtra( "photo_delete_transaction", {
          chunk: index,
          chunks: chunks.length,
          requested: chunk.length,
          deleted: chunkDeleted,
          appCreated: ( chunkResult as { appCreated?: number } | undefined )?.appCreated ?? -1,
          transactionMs: ( chunkResult as { transactionMs?: number } | undefined )?.transactionMs
            ?? Date.now( ) - chunkStartedAt,
        } );
      }
      return progress;
    };
    const deletion = runChunks( );
    const result = await Promise.race( [
      deletion,
      new Promise<typeof STILL_PENDING>( resolve => {
        timeoutTimer = setTimeout(
          ( ) => resolve( STILL_PENDING ),
          uiWaitMs( chunks.length ),
        );
      } ),
    ] );
    if ( result === STILL_PENDING ) {
      // Say so when it does land. Whether a deletion the UI gave up on still
      // goes through is the open question in this whole investigation, and the
      // log could only ever answer it by comparing photo counts across two
      // visits to the cleanup screen.
      void deletion.then(
        lateResult => logger.info(
          `Delete of ${requested} device photo(s) settled ${Date.now( ) - startedAt}ms in, `
          + `after the UI stopped waiting; result=${JSON.stringify( lateResult )}`,
        ),
        lateError => logger.errorWithExtra( "photo_delete_late_failure", {
          requested,
          chunk: progress.done,
          chunks: chunks.length,
          deletedBefore: progress.deleted,
          ms: Date.now( ) - startedAt,
          error: String( lateError ),
        } ),
      // Chunks that did land are gone whatever the abandoned one does, so stop
      // tracking them as ours either way.
      ).finally( ( ) => forgetAppCreatedPhotoAssets( cleared ) );
      return {
        deleted: progress.deleted,
        requested,
        succeeded: false,
        pending: true,
      };
    }
    logger.info(
      `Deleted ${progress.deleted} of ${requested} `
      + `device photo(s); result=${JSON.stringify( result )}`,
    );
    if ( cleared.length > 0 ) forgetAppCreatedPhotoAssets( cleared );
    return {
      deleted: progress.deleted,
      requested,
      succeeded: true,
      undeletable: progress.undeletable,
    };
  } catch ( deleteError ) {
    // Chunks that landed before this one failed are gone, so they stop being
    // ours to track and they count towards what the caller reports.
    if ( cleared.length > 0 ) forgetAppCreatedPhotoAssets( cleared );
    if ( isLibraryBusy( deleteError ) ) {
      // Comes back in milliseconds, so the user isn't left waiting — and the
      // 150s this would otherwise have spent stacked on a wedged
      // photolibraryd is exactly what made the Aug 9 log's second and third
      // attempts as useless as the first.
      logger.warnWithExtra( "photo_delete_library_busy", {
        requested,
        chunk: progress.done,
        chunks: chunks.length,
        detail: String( ( deleteError as { message?: string } )?.message ?? deleteError ),
      } );
      if ( options.userInitiated ) {
        Alert.alert(
          i18next.t( "Something-went-wrong" ),
          i18next.t( "Photos-stopped-responding-restart-the-app" ),
        );
      }
      return { deleted: progress.deleted, requested, succeeded: false };
    }
    // As of iOS 26, PHPhotoLibrary.performChanges' completion handler for
    // deleteAssets can simply never fire — no confirmation dialog, no error,
    // no library change (confirmed via a native PHPhotoLibraryChangeObserver
    // fallback in ImageCropper.m, and matches Apple Developer Forums thread
    // 806349). There's no way to make the OS call back, and restarting the
    // device is still the only known way to clear it — but a failure here says
    // nothing about the next delete, so nothing is remembered from it. Every
    // deletion gets its own attempt, however the last one ended.
    logger.errorWithExtra(
      "photo_delete_failed",
      deleteError,
      { ...pendingExtra( ), chunk: progress.done, chunks: chunks.length },
    );
    // A chunked cleanup that got most of the way is not a failed one: telling
    // the user nothing was deleted when 800 photos were is the report that sent
    // this whole investigation looking in the wrong place to begin with.
    if ( options.userInitiated && progress.deleted === 0 ) {
      Alert.alert(
        i18next.t( "Something-went-wrong" ),
        i18next.t( "Could-not-delete-original-photos" ),
      );
    }
    return {
      deleted: progress.deleted,
      requested,
      succeeded: false,
      undeletable: progress.undeletable,
    };
  } finally {
    clearTimeout( hangTimer );
    if ( timeoutTimer ) clearTimeout( timeoutTimer );
    appStateSubscription.remove( );
  }
};

export const deleteOriginalDevicePhotos = (
  photoUris: string[],
  options: DeleteOriginalDevicePhotosOptions = {},
): Promise<DeleteOriginalDevicePhotosResult> => enqueuePhotoLibraryWrite(
  holdChainUntil => performDeleteOriginalDevicePhotos( photoUris, options, holdChainUntil ),
);

// Callers hold the user on the current screen until onComplete fires so the
// iOS deletion confirmation isn't asked to present mid-navigation. A deletion
// normally settles in a couple of seconds, and one that hasn't answered stops
// being waited on after uiWaitMs. This stays above that: a delete queued
// behind another
// Photos-library write (see enqueuePhotoLibraryWrite) can wait longer than its
// own timeout, and stranding the user on a screen they asked to leave is far
// worse than letting the deletion finish unobserved in the background.
const exitWaitTimeoutMs = ( uriCount: number ) => uiWaitMs( chunkCount( uriCount ) ) + 5000;

// Deletes the original device photos that were imported, without prompting.
const promptDeleteOriginalDevicePhotos = (
  photoUris: string[],
  onComplete: () => void,
) => {
  const uniqueUris = filterDeletableDevicePhotoUris( photoUris );
  if ( uniqueUris.length === 0 ) {
    onComplete( );
    return;
  }

  let completed = false;
  const completeOnce = ( ) => {
    if ( completed ) return;
    completed = true;
    onComplete( );
  };
  const exitWaitMs = exitWaitTimeoutMs( uniqueUris.length );
  const waitTimer = setTimeout( ( ) => {
    logger.warn(
      `Proceeding without waiting for deletion of ${uniqueUris.length} device photo(s): `
      + `still pending after ${exitWaitMs}ms`,
    );
    completeOnce( );
  }, exitWaitMs );

  void deleteOriginalDevicePhotos( uniqueUris ).finally( ( ) => {
    clearTimeout( waitTimer );
    completeOnce( );
  } );
};

export default promptDeleteOriginalDevicePhotos;
