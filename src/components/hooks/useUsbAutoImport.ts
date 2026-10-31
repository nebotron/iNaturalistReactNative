import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import DeviceInfo from "react-native-device-info";
import { recordAppCreatedPhotoAssets } from "sharedHelpers/appCreatedPhotoAssets";
import {
  beginBackgroundUsbImportTask,
  endBackgroundUsbImportTask,
} from "sharedHelpers/backgroundExecution";
import { useOnboardingShown } from "sharedHelpers/installData";
import { log } from "sharedHelpers/logger";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import {
  addPendingUsbDeletes,
  availableMemoryMb,
  clearPendingUsbDeletes,
  clearUsbOffloadMarker,
  deleteUsbSourceImages,
  getPendingUsbDeletes,
  getUsbFolderDiagnostics,
  isCameraSubfolder,
  isUsbImportSupported,
  listNewUsbImages,
  markUsbImagesImported,
  markUsbOffloadStarted,
  reconcileSavedUsbImages,
  refreshAvailableMemory,
  requestUsbPhotosPermission,
  saveUsbImageToPhotos,
  takeUnfinishedUsbOffload,
  updateUsbOffloadProgress,
} from "sharedHelpers/usbStorage";
import useUsbImportProgress from "stores/usbImportProgress";

const logger = log.extend( "useUsbAutoImport" );

// Whether this process has already reported that the watched folder is one the
// camera will abandon (see isCameraSubfolder). Once per process: it's a fact
// about the setup, not an event, and every log line is a network POST.
let loggedCameraSubfolder = false;

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

// How often to re-check free space while waiting for room for the next file.
const WAIT_FOR_SPACE_INTERVAL_MS = 1_000;
const waitForSpaceInterval = ( ) => new Promise( resolve => {
  setTimeout( resolve, WAIT_FOR_SPACE_INTERVAL_MS );
} );

// Abandoned files stay unimported, so pressing Import again right away would
// pick the same card up and grind through the same failures again.
// Neither a wedged Photos library nor a full disk recovers on that timescale,
// so wait before trying the card again.
const SAVE_FAILING_RETRY_DELAY_MS = 10 * 60 * 1000;

// Every log line is a network POST, and a run that fails does it once per file.
// The abandon line below carries the totals, so only the first few failures
// need to say what the error actually was.
const MAX_LOGGED_SAVE_FAILURES = 3;

// How often the deadline below wakes up, and the most time any one wake-up can
// charge against it.
const TIMEOUT_TICK_MS = 1_000;
const MAX_CHARGE_PER_TICK_MS = 2 * TIMEOUT_TICK_MS;

// A deadline that counts only the time this process was actually running.
//
// An offload runs while the app is backgrounded, where iOS can freeze the
// process mid-save. A wall-clock setTimeout would then fire the instant the app
// resumes and report a save as timed out for time it was frozen; three timeouts
// in a row abandon the run and put the card in a ten-minute cooldown.
//
// Ticking charges elapsed time in bounded steps: a suspension costs one step,
// however long it lasted, while a save that really is wedged with the app
// running still hits the deadline on schedule.
const withTimeout = <T, >( promise: Promise<T>, ms: number ): Promise<T> => {
  let timer: ReturnType<typeof setInterval> | undefined;
  const deadline = new Promise<T>( ( _resolve, reject ) => {
    let remaining = ms;
    let lastTick = Date.now( );
    timer = setInterval( ( ) => {
      const now = Date.now( );
      remaining -= Math.min( now - lastTick, MAX_CHARGE_PER_TICK_MS );
      lastTick = now;
      if ( remaining > 0 ) return;
      reject( new Error( `timed out after ${ms}ms` ) );
    }, TIMEOUT_TICK_MS );
  } );
  return Promise.race( [promise, deadline] ).finally( ( ) => clearInterval( timer ) );
};

// Delete from the card the files already saved into Photos, and stop tracking
// them once the card has answered. Separate from the run that saved them so it
// can also finish what an earlier run left behind: deletion happens once, after
// a whole batch is safely saved, but each file is marked imported the moment it
// saves, so a run iOS suspends mid-loop strands its saved files on the card
// where no later scan will ever list them again.
const deletePendingFromDevice = async ( ) => {
  const paths = getPendingUsbDeletes( );
  if ( paths.length === 0 ) return null;
  const del = await deleteUsbSourceImages( paths );
  // Keep them pending only when the drive went away — that is the recoverable
  // case, and the one a later run can finish. A failure with the drive present
  // means the file is already gone or refuses to be deleted, and retrying it on
  // every scan from now on would never come good.
  if ( del.available !== false ) clearPendingUsbDeletes( paths );
  return { ...del, attempted: paths.length };
};

// Imports from the user's chosen USB folder (see UsbImportSetting) when they
// press Import there; nothing scans on its own, so an idle app never wakes for
// it. New images are offloaded: each is saved into the Photos library, then —
// once the whole batch is safely saved — deleted from the source device. A
// progress overlay (UsbImportProgress) reflects the run. Mounted once in App
// so a run outlives the Settings screen that started it; the run is published
// to that screen through the progress store.
const useUsbAutoImport = ( ) => {
  const [onboardingShown] = useOnboardingShown( );
  const offloading = useRef( false );
  const savesFailingUntil = useRef( 0 );
  // Each remote log line is a network POST, so repeated runs shouldn't repeat
  // the same diagnostics. Only emit one when its text changes from the last.
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

  // Resolves true when it found new photos and started a run.
  const offload = useCallback( async ( ): Promise<boolean> => {
    if ( !isUsbImportSupported( ) ) {
      logDiag( "skip: not supported on this platform" );
      return false;
    }
    if ( offloading.current ) return false;
    if ( !onboardingShown ) { logDiag( "skip: onboarding not shown yet" ); return false; }
    if ( Date.now( ) < savesFailingUntil.current ) {
      logDiag( "skip: waiting out a run of failed saves to the Photos library" );
      return false;
    }
    offloading.current = true;
    // Whether this scan found anything and put the banner on screen. A scan
    // that finds nothing — every scan, while no drive is attached — must not
    // touch the progress store or leave a timer behind for it.
    let started = false;
    // Whether this run is holding the shared background task, so the release in
    // `finally` matches the acquisition exactly once.
    let heldBackgroundTask = false;
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
      const reconciled = await reconcileSavedUsbImages( );
      if ( reconciled > 0 ) {
        logger.info(
          `USB offload: recorded ${reconciled} save(s) an earlier run never heard back from`,
        );
      }
      const result = await listNewUsbImages( );
      logDiag( result.available
        ? `list ok: ${result.images.length} new; imageFiles=${result.imageFileCount}, `
          + `alreadyImported=${result.alreadyImportedCount}, known=${result.knownCount}, `
          + `regularFiles=${result.regularFileCount}, dirs=${result.directoryCount}, `
          + `extensions=${JSON.stringify( result.extensions ?? {} )}`
        : `list produced nothing: ${result.reason}` );
      // A drive that scans clean every time, on a bookmark the camera has
      // walked away from, is indistinguishable in the log from a feature that
      // simply has nothing to do — and it is the state the app stays in until
      // the user picks a different folder. Say it once, as an error, so it
      // shows up in the grouped summary rather than among the info lines.
      if ( result.available && isCameraSubfolder( result ) && !loggedCameraSubfolder ) {
        loggedCameraSubfolder = true;
        logger.errorWithExtra( "usb_watching_camera_subfolder", {
          folder: result.name ?? "",
          imageFiles: result.imageFileCount ?? -1,
          regularFiles: result.regularFileCount ?? -1,
          directories: result.directoryCount ?? -1,
        } );
      }
      const { images } = result;
      if ( images.length === 0 ) {
        // Nothing new to save, but an earlier run may still have files sitting
        // on the card that it saved and never got to delete. This return is the
        // only place that case is ever reached, since those files are marked
        // imported and so are invisible to the scan above.
        if ( result.available ) {
          const leftovers = await deletePendingFromDevice( );
          if ( leftovers ) {
            logger.info(
              `USB offload: deleted ${leftovers.deleted} of ${leftovers.attempted} file(s) `
              + `an earlier run saved but did not delete (${leftovers.failed} delete failures)`,
            );
          }
        }
        return false;
      }

      // Get Photos permission before showing progress or touching any file, so
      // the system prompt appears up front rather than mid-loop (where it was
      // hiding behind the overlay and stalling the run at 0/N).
      const permission = await requestUsbPhotosPermission( );
      logDiag( `photos permission: ${permission}` );
      if ( permission !== "authorized" && permission !== "limited" ) {
        logger.error( `USB offload: Photos permission ${permission}; not importing` );
        return false;
      }

      logger.info( `USB offload: saving ${images.length} photos to Photos library` );
      started = true;
      progress.start( images.length );
      markUsbOffloadStarted( images.length );
      // Ask for background execution time now, while the app is still
      // foregrounded, rather than waiting until it is going away. iOS grants
      // the grace period to a task that is already registered when the app
      // leaves the foreground; a
      // beginBackgroundTask that only starts once "inactive" has fired is
      // racing the suspension it exists to survive, and loses often enough to
      // matter — the Sep 5 run saved 9 of 141 and stopped 6.7 seconds in with
      // appState "inactive", a fraction of the window it should have had.
      // Reference-counted, so this nests harmlessly inside other holds.
      heldBackgroundTask = await beginBackgroundUsbImportTask( );

      // Save each image to Photos, one at a time so memory stays flat and the
      // progress count is accurate. Track successes for the batch delete.
      const savedPaths: string[] = [];
      let failed = 0;
      let consecutiveFailures = 0;
      let loggedFailures = 0;
      let abandoned = 0;
      // Which condition ended the run early, and so which marker reports it and
      // what the banner tells the user.
      let abandonReason: "timeouts" | "failures" | "" = "";
      let lastError = "";
      // When this run started waiting for space, so the wait is logged once
      // when it starts and once when it ends rather than every second.
      let waitingSince = 0;
      let freeDiskBytes = -1;
      const startWaitingForSpace = (
        reason: string,
        position: string,
        fileSize: number | undefined,
        error = "",
      ) => {
        progress.setPhase( "waitingForSpace" );
        updateUsbOffloadProgress( savedPaths.length, failed, "waiting for space" );
        if ( waitingSince ) return;
        waitingSince = Date.now( );
        logger.warnWithExtra( "usb_offload_waiting_for_space", {
          reason,
          position,
          fileSizeBytes: fileSize ?? -1,
          freeDiskBytes,
          error,
        } );
      };
      const hasRoom = async ( fileSize: number | undefined ) => {
        freeDiskBytes = await DeviceInfo.getFreeDiskStorage( ).catch( ( ) => -1 );
        return freeDiskBytes < 0 || freeDiskBytes >= ( fileSize ?? 0 );
      };
      for ( let i = 0; i < images.length; i += 1 ) {
        const { relativePath, fileSize } = images[i];
        if ( abandonReason ) {
          abandoned = images.length - i;
          break;
        }
        // Wait, rather than give up, until there is room for this file: the
        // user can free space while the banner says so.
        const position = `${i + 1}/${images.length}`;
        // eslint-disable-next-line no-await-in-loop
        if ( !( await hasRoom( fileSize ) ) ) {
          startWaitingForSpace( "free-space-check", position, fileSize );
          // eslint-disable-next-line no-await-in-loop
          while ( !( await hasRoom( fileSize ) ) ) {
            // eslint-disable-next-line no-await-in-loop
            await waitForSpaceInterval( );
          }
        }
        if ( useUsbImportProgress.getState( ).phase === "waitingForSpace" ) {
          progress.setPhase( "saving" );
        }
        const fileStartedAt = Date.now( );
        // Which file, and whether it is waiting for the write chain or inside
        // the native save. A run that never comes back is reported from this
        // marker on the next launch, and "queued" vs "saving" is the
        // difference between a chain held by someone else's write and a save
        // that hung on its own.
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
          // And as still owed a deletion from the card, in storage that
          // outlives this run — savedPaths alone dies with the process.
          addPendingUsbDeletes( [relativePath] );
          consecutiveFailures = 0;
          if ( waitingSince ) {
            logger.info( `USB offload: resumed after waiting ${Date.now( ) - waitingSince}ms `
              + `for space (${freeDiskBytes} bytes free)` );
            waitingSince = 0;
          }
        } catch ( err ) {
          // The save needs more room than the file's own size. Not this file's
          // fault: wait and retry it, like the free-space check above.
          if ( ( err as { code?: string } )?.code === "out-of-space" ) {
            startWaitingForSpace(
              "save-out-of-space",
              position,
              fileSize,
              ( err instanceof Error
                ? err.message
                : String( err ) ).slice( 0, 200 ),
            );
            // eslint-disable-next-line no-await-in-loop
            await waitForSpaceInterval( );
            i -= 1;
            // eslint-disable-next-line no-continue
            continue;
          }
          failed += 1;
          consecutiveFailures += 1;
          // Read before anything else is awaited below: taken after the drive
          // diagnostics call, this was the time until the *log line*, not the
          // time the save took, and that call is itself a native round trip to
          // a drive that has just failed a write.
          const elapsedMs = Date.now( ) - fileStartedAt;
          const timedOut = err instanceof Error && err.message.includes( "timed out" );
          lastError = ( err instanceof Error
            ? err.message
            : String( err ) ).slice( 0, 200 );
          if ( consecutiveFailures >= MAX_CONSECUTIVE_SAVE_FAILURES ) {
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
            // logged one file that had stopped existing. AppState separates the
            // third case: a deadline that came due while iOS had the process
            // frozen, which is not the file's fault at all.
            // eslint-disable-next-line no-await-in-loop
            const drive = await getUsbFolderDiagnostics( ).catch( ( ) => null );
            logger.errorWithExtra( `USB offload: failed to save ${relativePath}`, {
              fileSizeBytes: fileSize ?? -1,
              elapsedMs,
              appState: AppState.currentState,
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
        // A card pulled mid-run fails every remaining copy instantly, which
        // trips the consecutive-failure counter like a wedged library does —
        // but it is not a condition of the device, and it is over the moment
        // the card goes back in. Charging it the ten-minute cooldown below left
        // the Sep 18 log skipping scans "waiting out a run of failed saves to
        // the Photos library" when the library had never been asked: the drive
        // had gone, 148 files unimported, and a card replugged a minute later
        // would have sat there unread for nine more. Read the drive here rather
        // than trusting the per-file diagnostics, which are only fetched for
        // the first MAX_LOGGED_SAVE_FAILURES failures of a run.
        const driveAtAbandon = await getUsbFolderDiagnostics( ).catch( ( ) => null );
        // Explicitly false, not merely absent: a diagnostics call that failed
        // or came back without an answer says nothing about the drive, and
        // waiving the cooldown on a wedged library is the one mistake here that
        // costs an hour of grinding.
        const driveGone = abandonReason === "failures"
          && driveAtAbandon?.reachable === false;
        if ( !driveGone ) {
          savesFailingUntil.current = Date.now( ) + SAVE_FAILING_RETRY_DELAY_MS;
        }
        // Distinct markers rather than one with a reason field: these are
        // different bugs with different fixes, and the grouped summary is only
        // useful if it can tell "the library is wedged again" from "the phone
        // is full" without opening the entries.
        const marker = driveGone
          ? "usb_offload_drive_gone"
          : {
            timeouts: "usb_offload_library_wedged",
            failures: "usb_offload_saves_failing",
          }[abandonReason];
        // The card being pulled is the user's doing, not a fault, so it goes in
        // at warn: still in the grouped summary, not in the error list the next
        // bug hunt starts from.
        const logAbandon = driveGone
          ? logger.warnWithExtra
          : logger.errorWithExtra;
        logAbandon( marker, {
          abandoned,
          saved: savedPaths.length,
          failed,
          total: images.length,
          consecutiveFailures,
          timeoutMs: SAVE_TIMEOUT_MS,
          // What this run actually costs the next one, which is nothing when
          // the card simply left.
          retryDelayMs: driveGone
            ? 0
            : SAVE_FAILING_RETRY_DELAY_MS,
          driveReachable: driveAtAbandon?.reachable ?? false,
          // The last failure's text, so a run abandoned for a reason nothing
          // here anticipated still says what it was. localizedDescription from
          // the native side: a message, never a path.
          lastError,
        } );
      }

      // Delete from the source device only after the whole batch is safely in
      // Photos (per the user's choice), and only files that actually saved —
      // this run's, plus anything an earlier run saved and never deleted.
      let deletedFromDevice = 0;
      let deleteFailures = 0;
      let driveGoneOnDelete = false;
      if ( getPendingUsbDeletes( ).length > 0 ) {
        progress.setPhase( "deleting" );
        updateUsbOffloadProgress(
          savedPaths.length,
          failed,
          "deleting",
          AppState.currentState,
        );
        const del = await deletePendingFromDevice( );
        // The native side already reports this and the run summary dropped it:
        // "deleted 0 of 15, 15 failures" reads as a deletion bug, when the
        // drive having been unplugged mid-run explains the whole line.
        driveGoneOnDelete = del?.available === false;
        deletedFromDevice = del?.deleted ?? 0;
        deleteFailures = del?.failed ?? 0;
        progress.setDeleted( deletedFromDevice );
      }
      // Reported even when nothing saved, since a run where every file failed
      // most needs an outcome. Skipped only when the wedged line above already
      // carries the same counts.
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
      // An abandoned run can have no failures — the free-space check stops it
      // before any save — and must not read as "Import complete".
      progress.setPhase( failed > 0 || abandonReason
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
      if ( heldBackgroundTask ) {
        heldBackgroundTask = false;
        endBackgroundUsbImportTask( );
      }
      // Leave the final state on screen briefly, then dismiss the overlay.
      if ( started ) {
        setTimeout( ( ) => useUsbImportProgress.getState( ).finish( ), 4000 );
      }
    }
    return started;
  }, [onboardingShown, logDiag] );

  useEffect( ( ) => {
    useUsbImportProgress.setState( { startImport: offload } );
    return ( ) => useUsbImportProgress.setState( { startImport: undefined } );
  }, [offload] );

  return offload;
};

export default useUsbAutoImport;
