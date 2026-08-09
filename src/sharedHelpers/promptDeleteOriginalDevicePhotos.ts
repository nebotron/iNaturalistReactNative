import {
  CameraRoll,
  iosRequestReadWriteGalleryPermission,
} from "@react-native-camera-roll/camera-roll";
import i18next from "i18next";
import {
  Alert, AppState, NativeModules, Platform,
} from "react-native";
import {
  appCreatedPhotoUris,
  forgetAppCreatedPhotoAssets,
  isAppCreatedDeleteExemptionConfirmed,
  recordAppCreatedDeletionTiming,
} from "sharedHelpers/appCreatedPhotoAssets";
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
    deletePhotoAssets?: (
      phUris: string[],
      appCreatedUris: string[]
    ) => Promise<{
      deleted: number;
      requested: number;
      fetched?: number;
      appCreated?: number;
      appCreatedDeleted?: number;
      appCreatedMs?: number;
      prompted?: number;
      promptedDeleted?: number;
      promptedChunks?: number;
      promptedMaxChunk?: number;
      promptedMs?: number;
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

// Mirrors kInatPromptedDeleteChunkSize / kInatPromptedDeleteChunkStep in
// ImageCropper.m, where the prompted half goes out in chunks of 15, 20, 25 and
// so on. Only used to size the diagnostic below, so the two drifting apart costs
// nothing but a slightly mistimed log line.
const PROMPTED_DELETE_CHUNK_SIZE = 15;
const PROMPTED_DELETE_CHUNK_STEP = 5;

// How many transactions the ramp needs to cover this many prompted assets.
const promptedTransactionCount = ( prompted: number ) => {
  let remaining = prompted;
  let size = PROMPTED_DELETE_CHUNK_SIZE;
  let count = 0;
  while ( remaining > 0 ) {
    remaining -= size;
    size += PROMPTED_DELETE_CHUNK_STEP;
    count += 1;
  }
  return count;
};

// A PhotoKit transaction costs ~1.6s whatever it holds: 3 assets took 1752ms,
// 19 took 1442ms, 275 consent-free ones took 1691ms. So a chunked walk's honest
// duration scales with the number of transactions, not the photo count — and a
// flat 5s budget reported the first working cleanup (37 photos, 3 chunks,
// 5005ms) as a hang 4ms before it finished. Allow for the walk, then report.
const CHUNK_MS_ALLOWANCE = 1800;

// The pending-delete diagnostic has to land while the delete is still in
// flight, so it stays inside the wait above however many chunks are expected.
const hangReportMs = ( transactions: number ) => Math.min(
  UI_WAIT_MS - 2000,
  3000 + CHUNK_MS_ALLOWANCE * transactions,
);

// Returned by the race below when the OS hasn't answered inside UI_WAIT_MS.
const STILL_PENDING = { stillPending: true } as const;

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

  // Assets the app added to the library itself (the USB card offload) are the
  // only ones PhotoKit deletes without presenting its confirmation, so they
  // can go in a transaction of their own — see deletePhotoAssets in
  // ImageCropper.m.
  //
  // Splitting a *mixed* batch is only safe once that exemption has been seen
  // to hold on this device: if it doesn't, the split is two prompted
  // transactions and the user confirms twice for one import. So split when
  // every asset is ours — one transaction either way, and the controlled
  // measurement the exemption is judged on — or when such a batch has already
  // proved the exemption real. Anything else stays a single transaction, and
  // so a single prompt.
  //
  // Decided here, ahead of the hang timers, so a hang report can say which
  // transaction was outstanding. Reading that off the adjacent prose line meant
  // loading the dump to answer the single most important question about a hang.
  const ourUris = appCreatedPhotoUris( uniqueUris );
  const appCreatedUris = (
    ourUris.length === uniqueUris.length || isAppCreatedDeleteExemptionConfirmed( )
  )
    ? ourUris
    : [];

  // How many PhotoKit transactions this deletion should take: one per chunk of
  // the prompted half, plus one for the consent-free half if there is one. It
  // sizes the pending diagnostic, and a hang report carrying it says how much of
  // the walk was still to come.
  const expectedTransactions = Math.max(
    1,
    promptedTransactionCount( requested - appCreatedUris.length )
      + ( appCreatedUris.length > 0
        ? 1
        : 0 ),
  );

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
    // Which half of the split was in flight. A hang with prompted=0 is a
    // deletion that issued only the consent-free transaction, and the Aug 6
    // log has one: 17 of 17 app-created, no prompted transaction created at
    // all, hung exactly like a prompted one. That is what rules the consent
    // alert out as the thing that wedges the library, so it belongs on the
    // hang report rather than being inferred from the prose line beside it.
    appCreated: appCreatedUris.length,
    prompted: requested - appCreatedUris.length,
    expectedTransactions,
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
  }, hangReportMs( expectedTransactions ) );
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
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

    const appCreatedNote = appCreatedUris.length > 0
      ? `, ${appCreatedUris.length} of them app-created`
      : "";
    logger.info( `Deleting ${uniqueUris.length} device photo(s)${appCreatedNote}` );
    // Prefer the native path that dismisses a blocking modal before deleting;
    // fall back to CameraRoll on platforms/builds without it.
    const deletion = ( Platform.OS === "ios" && ImageCropper?.deletePhotoAssets )
      ? ImageCropper.deletePhotoAssets( uniqueUris, appCreatedUris )
      : CameraRoll.deletePhotos( uniqueUris );
    // Whatever we decide below, the next Photos-library write waits for this
    // transaction rather than stacking on top of it.
    holdChainUntil( deletion );
    const result = await Promise.race( [
      deletion,
      new Promise<typeof STILL_PENDING>( resolve => {
        timeoutTimer = setTimeout( ( ) => resolve( STILL_PENDING ), UI_WAIT_MS );
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
          ms: Date.now( ) - startedAt,
          error: String( lateError ),
        } ),
      );
      return {
        deleted: 0, requested, succeeded: false, pending: true,
      };
    }
    // Report what the OS actually deleted, not what we asked for. A call that
    // resolves with deleted:0 (e.g. fetched:0 — every URI is a ghost pointing
    // at an already-deleted asset) is a no-op, and logging it as a deletion of
    // all N made a repeating no-op look like a working cleanup.
    const deleted = ( result as { deleted?: number } | undefined )?.deleted;
    logger.info(
      `Deleted ${deleted ?? requested} of ${requested} `
      + `device photo(s); result=${JSON.stringify( result )}`,
    );
    // What the chunked prompted walk did. promptedChunks is how many
    // transactions came back, so promptedDeleted < prompted says which chunk
    // stopped it — and promptedMs/promptedChunks says whether a human is
    // answering a confirmation per chunk (~1.5s each means nobody is).
    const promptedWalk = result as {
      prompted?: number;
      promptedDeleted?: number;
      promptedChunks?: number;
      promptedMaxChunk?: number;
      promptedMs?: number;
    } | undefined;
    if ( ( promptedWalk?.prompted ?? 0 ) > 0 ) {
      logger.infoWithExtra( "photo_delete_prompted", {
        prompted: promptedWalk?.prompted,
        promptedDeleted: promptedWalk?.promptedDeleted,
        promptedChunks: promptedWalk?.promptedChunks,
        // The largest chunk the ramp got an answer for. This is the number the
        // chunk size is tuned against: it rises run over run until it stops.
        promptedMaxChunk: promptedWalk?.promptedMaxChunk,
        promptedMs: promptedWalk?.promptedMs,
      } );
    }
    // How long the unprompted half took is the measurement this whole split
    // exists for, and it decides whether to keep splitting.
    const appCreatedMs = ( result as { appCreatedMs?: number } | undefined )?.appCreatedMs;
    const appCreatedResult = result as { appCreatedDeleted?: number } | undefined;
    const appCreatedDeleted = appCreatedResult?.appCreatedDeleted ?? 0;
    if ( typeof appCreatedMs === "number" && appCreatedUris.length > 0 ) {
      recordAppCreatedDeletionTiming( appCreatedMs );
      logger.infoWithExtra( "photo_delete_app_created", {
        appCreated: appCreatedUris.length,
        appCreatedDeleted,
        appCreatedMs,
        prompted: requested - appCreatedUris.length,
        // The half of the comparison that was missing. An unprompted
        // transaction should be quick where a prompted one waits on a human,
        // so promptedMs >> appCreatedMs per asset is what a real exemption
        // looks like; the two coming back alike means either both prompt or
        // neither does.
        promptedMs: ( result as { promptedMs?: number } | undefined )?.promptedMs ?? -1,
      } );
    }
    // A transaction deletes all of its assets or none of them, so anything
    // above zero means these are gone and no longer worth tracking. Keep them
    // if it failed: they still need deleting, and still without a prompt.
    if ( appCreatedDeleted > 0 ) forgetAppCreatedPhotoAssets( appCreatedUris );
    return { deleted: deleted ?? requested, requested, succeeded: true };
  } catch ( deleteError ) {
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
      pendingExtra( ),
    );
    if ( options.userInitiated ) {
      Alert.alert(
        i18next.t( "Something-went-wrong" ),
        i18next.t( "Could-not-delete-original-photos" ),
      );
    }
    return { deleted: 0, requested, succeeded: false };
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
// being waited on after UI_WAIT_MS. This stays above that: a delete queued
// behind another
// Photos-library write (see enqueuePhotoLibraryWrite) can wait longer than its
// own timeout, and stranding the user on a screen they asked to leave is far
// worse than letting the deletion finish unobserved in the background.
const EXIT_WAIT_TIMEOUT_MS = 20000;

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
  const waitTimer = setTimeout( ( ) => {
    logger.warn(
      `Proceeding without waiting for deletion of ${uniqueUris.length} device photo(s): `
      + `still pending after ${EXIT_WAIT_TIMEOUT_MS}ms`,
    );
    completeOnce( );
  }, EXIT_WAIT_TIMEOUT_MS );

  void deleteOriginalDevicePhotos( uniqueUris ).finally( ( ) => {
    clearTimeout( waitTimer );
    completeOnce( );
  } );
};

export default promptDeleteOriginalDevicePhotos;
