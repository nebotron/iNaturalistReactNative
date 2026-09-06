import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { recordAppCreatedPhotoAssets } from "sharedHelpers/appCreatedPhotoAssets";
import {
  beginBackgroundUsbImportTask,
  endBackgroundUsbImportTask,
} from "sharedHelpers/backgroundExecution";
import { useOnboardingShown } from "sharedHelpers/installData";
import { log } from "sharedHelpers/logger";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import {
  availableMemoryMb,
  clearUsbOffloadMarker,
  deleteUsbSourceImages,
  getUsbFolderDiagnostics,
  getUsbFolderName,
  isUsbImportSupported,
  listNewUsbImages,
  markUsbImagesImported,
  markUsbOffloadStarted,
  refreshAvailableMemory,
  requestUsbPhotosPermission,
  saveUsbImageToPhotos,
  takeUnfinishedUsbOffload,
  updateUsbOffloadProgress,
} from "sharedHelpers/usbStorage";
import useUsbImportProgress from "stores/usbImportProgress";

const logger = log.extend( "useUsbAutoImport" );

// How often to re-check the watched folder while the app is foregrounded.
const SCAN_INTERVAL_MS = 10_000;

// Whether this process has already said the user never picked a folder.
let loggedNoFolderBookmark = false;

// Safety net so a single native call that never resolves (a stuck copy or
// Photos import) can't freeze the whole run — that file is counted as failed
// and the loop moves on.
const SAVE_TIMEOUT_MS = 30_000;

// The same net around the *wait* for the shared Photos-library write chain.
// SAVE_TIMEOUT_MS only covers the native call once the chain reaches this
// file; a task queued ahead of it that never settles holds the chain (see
// enqueuePhotoLibraryWrite) and the await above it had no bound at all — which
// is a run that stops dead with no line to say so. The Aug 12 offload sat for
// 4h9m having saved 0 of 21, and nothing distinguished that from iOS having
// suspended the app. Sized above the chain's own CHAIN_HOLD_MS (170s) so a
// merely slow write ahead of us is never mistaken for a wedge.
const QUEUED_SAVE_TIMEOUT_MS = 200_000;

// Saving to Photos is a PHPhotoLibrary write, and those can wedge for the whole
// device (see promptDeleteOriginalDevicePhotos.ts). When that happens every
// remaining file in the run burns the full SAVE_TIMEOUT_MS in turn — the Aug 5
// log caught a 122-photo card starting down that path, which is an hour of
// grinding to save nothing and one error line per file. A single failure is an
// ordinary bad file and the loop should carry on past it; a run of them is a
// condition of the device, and nothing on the card will save until it changes.
// Counted for failures of *any* kind, not just timeouts: on Aug 6 the phone ran
// out of disk space, every copy failed instantly rather than timing out, and a
// timeouts-only counter reset on each one — so the loop ran all 157 files in a
// second and a half and the poll did it again ten seconds later, 1,084 error
// lines in 74 seconds.
const MAX_CONSECUTIVE_SAVE_FAILURES = 3;

// Abandoned files stay unimported, so the next scan — SCAN_INTERVAL_MS later —
// would pick the same card up and grind through the same failures again.
// Neither a wedged Photos library nor a full disk recovers on that timescale,
// so wait before trying the card again.
const SAVE_FAILING_RETRY_DELAY_MS = 10 * 60 * 1000;

// Every log line is a network POST, and a run that fails does it once per file.
// The abandon line below carries the totals, so only the first few failures
// need to say what the error actually was.
const MAX_LOGGED_SAVE_FAILURES = 3;

const withTimeout = <T, >( promise: Promise<T>, ms: number ): Promise<T> => (
  Promise.race( [
    promise,
    new Promise<T>( ( _resolve, reject ) => {
      setTimeout( ( ) => reject( new Error( `timed out after ${ms}ms` ) ), ms );
    } ),
  ] )
);

// Watches the user's chosen USB folder (see UsbImportSetting) on launch and
// on a short interval. iOS offers no attach notification, and a drive is
// commonly plugged in *after* the app is already open — a moment that fires
// neither a launch nor a foreground event — so polling is the only way to
// notice it. Polling also keeps running for a while after the app
// backgrounds (via a background task, same mechanism as observation upload)
// so a card inserted right as the app leaves the foreground still gets
// caught, rather than requiring the user to return to the app first. When new
// images are found they are offloaded: each is saved into the Photos
// library, then — once the whole batch is safely saved — deleted from the
// source device. A progress overlay (UsbImportProgress) reflects the run.
const useUsbAutoImport = ( ) => {
  const [onboardingShown] = useOnboardingShown( );
  const offloading = useRef( false );
  const savesFailingUntil = useRef( 0 );
  const backgroundTaskActive = useRef( false );
  // The scan runs every SCAN_INTERVAL_MS while foregrounded, and each remote
  // log line is a network POST, so logging every tick would flood the log.
  // Only emit a diagnostic when its text changes from the last one.
  // Remembered per kind of message, not as one last-seen string: a scan emits
  // "polling…" and then "list ok…", so two unchanging diagnostics alternate and
  // a single slot never matches either of them. Nine of the 92 lines in the
  // Aug 5 16:04–16:40 log were byte-identical repeats this already meant to
  // suppress.
  const lastDiag = useRef<Record<string, string>>( {} );
  const logDiag = useCallback( ( msg: string, level: "info" | "debug" = "info" ) => {
    const kind = msg.split( ":" )[0];
    if ( msg === lastDiag.current[kind] ) return;
    lastDiag.current[kind] = msg;
    logger[level]( `[diag] ${msg}` );
  }, [] );

  const offload = useCallback( async ( ) => {
    if ( !isUsbImportSupported( ) ) { logDiag( "skip: not supported on this platform" ); return; }
    // An offload already in flight is normal overlap on the poll, not an error.
    if ( offloading.current ) return;
    if ( !onboardingShown ) { logDiag( "skip: onboarding not shown yet" ); return; }
    if ( Date.now( ) < savesFailingUntil.current ) {
      logDiag( "skip: waiting out a run of failed saves to the Photos library" );
      return;
    }
    offloading.current = true;
    // Whether this scan found anything and put the banner on screen. A scan
    // that finds nothing — every scan, while no drive is attached — must not
    // touch the progress store or leave a timer behind for it.
    let started = false;
    const progress = useUsbImportProgress.getState( );
    // An offload the app never came back from. Reported here rather than at
    // launch because a run that died left its files unimported, so the next
    // offload follows within seconds of the relaunch anyway.
    const unfinished = takeUnfinishedUsbOffload( );
    if ( unfinished ) {
      logger.errorWithExtra( "usb_offload_never_finished", {
        total: unfinished.total,
        saved: unfinished.saved,
        failed: unfinished.failed,
        msRunning: Date.now( ) - unfinished.startedAt,
        // A run frozen by iOS stops updating the marker the moment the process
        // is suspended, in the background, mid-file; a native call that wedges
        // does the same thing with the app still active. Without these three
        // the two are the same log line.
        msSinceProgress: unfinished.lastProgressAt
          ? Date.now( ) - unfinished.lastProgressAt
          : -1,
        phase: unfinished.phase ?? "unknown",
        appStateAtLastProgress: unfinished.appState ?? "unknown",
        // Headroom left when it stopped: an offload that dies with the app
        // active and a few MB to spare was killed for memory, not wedged.
        availableMemoryMbAtLastProgress: unfinished.availableMemoryMb ?? -1,
      } );
    }
    try {
      const result = await listNewUsbImages( );
      logDiag( result.available
        ? `list ok: ${result.images.length} new; imageFiles=${result.imageFileCount}, `
          + `alreadyImported=${result.alreadyImportedCount}, known=${result.knownCount}, `
          + `regularFiles=${result.regularFileCount}, `
          + `extensions=${JSON.stringify( result.extensions ?? {} )}`
        : `list produced nothing: ${result.reason}` );
      const { images } = result;
      if ( images.length === 0 ) return;

      // Get Photos permission before showing progress or touching any file, so
      // the system prompt appears up front rather than mid-loop (where it was
      // hiding behind the overlay and stalling the run at 0/N).
      const permission = await requestUsbPhotosPermission( );
      logDiag( `photos permission: ${permission}` );
      if ( permission !== "authorized" && permission !== "limited" ) {
        logger.error( `USB offload: Photos permission ${permission}; not importing` );
        return;
      }

      logger.info( `USB offload: saving ${images.length} photos to Photos library` );
      started = true;
      progress.start( images.length );
      markUsbOffloadStarted( images.length );

      // Save each image to Photos, one at a time so memory stays flat and the
      // progress count is accurate. Track successes for the batch delete.
      const savedPaths: string[] = [];
      let failed = 0;
      let consecutiveFailures = 0;
      let loggedFailures = 0;
      let abandoned = 0;
      // Which condition ended the run early, and so which marker reports it and
      // what the banner tells the user.
      let abandonReason: "timeouts" | "out-of-space" | "failures" | "" = "";
      let lastError = "";
      for ( let i = 0; i < images.length; i += 1 ) {
        const { relativePath, fileSize } = images[i];
        if ( abandonReason ) {
          abandoned = images.length - i;
          break;
        }
        const fileStartedAt = Date.now( );
        // Which file, and whether it is waiting for the write chain or inside
        // the native save. A run that never comes back is reported from this
        // marker on the next launch, and "queued" vs "saving" is the
        // difference between a chain held by someone else's write and a save
        // that hung on its own.
        const position = `${i + 1}/${images.length}`;
        const failedBeforeThisFile = failed;
        // Sampled per file rather than awaited: the value only has to be
        // recent, and the marker is read after the fact.
        refreshAvailableMemory( );
        updateUsbOffloadProgress(
          savedPaths.length,
          failedBeforeThisFile,
          `queued ${position}`,
          AppState.currentState,
          availableMemoryMb( ),
        );
        try {
          // On the shared Photos-library write chain, like every other native
          // library write in the app. This is the app's largest source of them
          // — 114 in a run, one per file — and it was the one path outside the
          // chain, so an offload overlapped whatever else the app was doing to
          // the library — and a delete racing a save can hang on a library that
          // is servicing both perfectly well, as the Aug 5 16:04–16:40 log
          // showed while 68 assets were created without complaint.
          // Enqueued per file rather than per run so a deletion waits for one
          // photo, not a whole card.
          // eslint-disable-next-line no-await-in-loop
          const saved = await withTimeout( enqueuePhotoLibraryWrite( ( ) => {
            updateUsbOffloadProgress(
              savedPaths.length,
              failedBeforeThisFile,
              `saving ${position}`,
              AppState.currentState,
              availableMemoryMb( ),
            );
            return withTimeout( saveUsbImageToPhotos( relativePath ), SAVE_TIMEOUT_MS );
          } ), QUEUED_SAVE_TIMEOUT_MS );
          savedPaths.push( relativePath );
          // Remember that this asset is ours. These are the only photos in the
          // library the app created, and the only ones PhotoKit will let it
          // delete without a confirmation — the confirmation the deletion
          // hangs are stuck on.
          if ( saved?.localIdentifier ) {
            recordAppCreatedPhotoAssets( [saved.localIdentifier] );
          }
          // Mark imported immediately, not after the whole batch: if the app
          // is killed mid-loop, photos already saved to this point must not
          // be saved again on restart.
          markUsbImagesImported( [relativePath] );
          consecutiveFailures = 0;
        } catch ( err ) {
          failed += 1;
          consecutiveFailures += 1;
          const timedOut = err instanceof Error && err.message.includes( "timed out" );
          lastError = ( err instanceof Error
            ? err.message
            : String( err ) ).slice( 0, 200 );
          // No room on the phone is a whole-device condition, not this file's
          // problem — the next 156 copies cannot succeed either, so don't try
          // them.
          if ( ( err as { code?: string } )?.code === "out-of-space" ) {
            abandonReason = "out-of-space";
          } else if ( consecutiveFailures >= MAX_CONSECUTIVE_SAVE_FAILURES ) {
            abandonReason = timedOut
              ? "timeouts"
              : "failures";
          }
          if ( loggedFailures < MAX_LOGGED_SAVE_FAILURES ) {
            loggedFailures += 1;
            // Size and elapsed time: eight saves have timed out at exactly
            // SAVE_TIMEOUT_MS over ~1,300 files, and nothing said whether 30s
            // is simply short for a 40MB raw over USB or whether the write
            // never started. Drive state separates a bad file from a card that
            // was pulled mid-run — the Aug 13 run saved 15, deleted none, and
            // logged one file that had stopped existing.
            // eslint-disable-next-line no-await-in-loop
            const drive = await getUsbFolderDiagnostics( ).catch( ( ) => null );
            logger.errorWithExtra( `USB offload: failed to save ${relativePath}`, {
              fileSizeBytes: fileSize ?? -1,
              elapsedMs: Date.now( ) - fileStartedAt,
              timedOut,
              index: i + 1,
              total: images.length,
              driveReachable: drive?.reachable ?? false,
              driveResolved: drive?.resolved ?? false,
              driveStale: drive?.stale ?? false,
              error: lastError,
            } );
          }
        }
        progress.setCounts( savedPaths.length, failed );
        updateUsbOffloadProgress( savedPaths.length, failed );
      }

      if ( abandonReason ) {
        savesFailingUntil.current = Date.now( ) + SAVE_FAILING_RETRY_DELAY_MS;
        // Distinct markers rather than one with a reason field: these are
        // different bugs with different fixes, and the grouped summary is only
        // useful if it can tell "the library is wedged again" from "the phone
        // is full" without opening the entries.
        const marker = {
          timeouts: "usb_offload_library_wedged",
          "out-of-space": "usb_offload_out_of_space",
          failures: "usb_offload_saves_failing",
        }[abandonReason];
        logger.errorWithExtra( marker, {
          abandoned,
          saved: savedPaths.length,
          failed,
          total: images.length,
          consecutiveFailures,
          timeoutMs: SAVE_TIMEOUT_MS,
          retryDelayMs: SAVE_FAILING_RETRY_DELAY_MS,
          // The last failure's text, so a run abandoned for a reason nothing
          // here anticipated still says what it was. localizedDescription from
          // the native side: a message, never a path.
          lastError,
        } );
      }

      // Delete from the source device only after the whole batch is safely in
      // Photos (per the user's choice), and only the files that actually saved.
      let deletedFromDevice = 0;
      let deleteFailures = 0;
      let driveGoneOnDelete = false;
      if ( savedPaths.length > 0 ) {
        progress.setPhase( "deleting" );
        updateUsbOffloadProgress(
          savedPaths.length,
          failed,
          "deleting",
          AppState.currentState,
        );
        const del = await deleteUsbSourceImages( savedPaths );
        // The native side already reports this and the run summary dropped it:
        // "deleted 0 of 15, 15 failures" reads as a deletion bug, when the
        // drive having been unplugged mid-run explains the whole line.
        driveGoneOnDelete = del.available === false;
        progress.setDeleted( del.deleted );
        deletedFromDevice = del.deleted;
        deleteFailures = del.failed;
      }
      // Reported even when nothing saved. This line used to sit inside the
      // branch above, so the one run that most needed explaining — every file
      // failing — was the one run that logged no outcome at all, and the Aug 5
      // log couldn't say whether the offload finished or the app died holding
      // it. Skipped only when the wedged line above already carries the same
      // counts.
      if ( !abandonReason ) {
        const driveNote = driveGoneOnDelete
          ? "; drive no longer available"
          : "";
        logger.info(
          `USB offload: saved ${savedPaths.length}, failed ${failed}; `
          + `deleted ${deletedFromDevice} from device `
          + `(${deleteFailures} delete failures)${driveNote}`,
        );
      }
      if ( abandonReason === "out-of-space" ) {
        progress.setNote( "There's no room left on this device." );
      }
      progress.setPhase( failed > 0
        ? "error"
        : "done" );
    } catch ( error ) {
      logger.error( "USB offload failed", error );
      if ( started ) progress.setPhase( "error" );
    } finally {
      // The run reached an end, however badly, so it is not one of the runs
      // that vanish with the process.
      clearUsbOffloadMarker( );
      offloading.current = false;
      // Leave the final state on screen briefly, then dismiss the overlay.
      if ( started ) {
        setTimeout( ( ) => useUsbImportProgress.getState( ).finish( ), 4000 );
      }
    }
  }, [onboardingShown, logDiag] );

  useEffect( ( ) => {
    // Report why the hook doesn't engage, in the cases (native module missing,
    // onboarding not finished) that otherwise leave the feature completely
    // silent. The supported-and-onboarded case needs no line: the polling
    // diagnostics below already show the hook running.
    const supported = isUsbImportSupported( );
    if ( !supported || !onboardingShown ) {
      logDiag( `not engaging: supported=${supported}, onboardingShown=${onboardingShown}` );
      return ( ) => {};
    }

    let interval: ReturnType<typeof setInterval> | undefined;
    const stopPolling = ( ) => {
      if ( interval ) clearInterval( interval );
      interval = undefined;
    };
    const startPolling = async ( ) => {
      stopPolling( );
      try {
        // Nothing to watch until the user has chosen a folder; don't wake the JS
        // thread on an interval for the many users who never set one up.
        const folder = await getUsbFolderName( );
        if ( !folder ) {
          // A null name has two very different causes, and they call for
          // opposite things: with no bookmark there is nothing to watch, but an
          // unresolvable one is exactly what a saved folder looks like with the
          // drive unplugged — which is the state the app is in every time the
          // user is about to plug one in. Bailing out of polling here meant the
          // interval only ever started if the drive happened to already be
          // mounted at launch or at the last foreground, so the case this hook
          // exists for — plugging a card reader into a phone with the app open,
          // which fires no launch and no foreground event — was the one case it
          // never noticed. Keep polling and let each scan re-resolve.
          const d = await getUsbFolderDiagnostics( );
          if ( !d.bookmarkPresent ) {
            if ( !loggedNoFolderBookmark ) {
              // Once per process. It explains a feature that is silently doing
              // nothing, which is worth saying — but it fires on every
              // foreground, and thirty identical copies say nothing the first
              // one didn't.
              loggedNoFolderBookmark = true;
              logDiag( "not polling: no folder bookmark saved (folder never picked in Settings)" );
            }
            return;
          }
          // Nine of these in the Aug 4 log, one per foreground, none of them a
          // bug. Keep it at debug (out of release builds) rather than reporting
          // "no camera attached" to the shared log all day.
          logDiag(
            "polling for the drive: folder bookmark saved but did not resolve "
              + `(resolved=${d.resolved}, reachable=${d.reachable}, stale=${d.stale})`,
            "debug",
          );
        } else {
          logDiag( `polling USB folder "${folder}" every ${SCAN_INTERVAL_MS}ms` );
          offload( );
        }
        // Scan on the interval either way: offload re-resolves the folder each
        // time and returns in one cheap native call while the drive is absent.
        interval = setInterval( offload, SCAN_INTERVAL_MS );
      } catch ( error ) {
        // A rejected native call would otherwise be an unhandled promise
        // rejection with no trace of why polling never started.
        logger.error( "USB polling failed to start", error );
      }
    };

    startPolling( );
    const subscription = AppState.addEventListener( "change", async nextAppState => {
      if ( nextAppState === "active" ) {
        if ( backgroundTaskActive.current ) {
          await endBackgroundUsbImportTask( );
          backgroundTaskActive.current = false;
        }
        startPolling( );
        return;
      }
      // Don't stop polling on background/inactive: hold a background task so
      // iOS keeps the JS thread alive for a while, and let the interval keep
      // checking the folder during that window.
      if ( !backgroundTaskActive.current ) {
        backgroundTaskActive.current = await beginBackgroundUsbImportTask( );
      }
    } );
    return ( ) => {
      stopPolling( );
      subscription.remove( );
      if ( backgroundTaskActive.current ) {
        endBackgroundUsbImportTask( );
        backgroundTaskActive.current = false;
      }
    };
  }, [offload, onboardingShown, logDiag] );
};

export default useUsbAutoImport;
