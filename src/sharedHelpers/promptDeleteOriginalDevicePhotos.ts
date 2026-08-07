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

// Whether a Photos-library write has ever gone through since launch, and how
// many have hung. The app log shows hangs arriving in day-long runs between
// runs of clean successes, so a hang report is only interpretable next to
// "the last write worked 4s ago" versus "nothing has worked all session".
let lastPhotoLibraryWriteSuccessAt: number | null = null;
let photoLibraryWriteHangCount = 0;

export const recordPhotoLibraryWriteSuccess = ( ) => {
  lastPhotoLibraryWriteSuccessAt = Date.now( );
};

// Native helpers (iOS) that (a) report the window/scene/modal state governing
// whether the iOS deletion confirmation can present, and (b) delete after
// dismissing any modal that would block that confirmation.
const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    photoDeletionContext?: ( phUris: string[] ) => Promise<string>;
    photoLibraryWriteProbe?: ( ) => Promise<{
      ok: boolean;
      ms: number;
      error: string;
      cleaned?: number;
    }>;
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

export const enqueuePhotoLibraryWrite = <T, >( task: ( ) => Promise<T> ): Promise<T> => {
  const run = photoLibraryWriteChain.then( task );
  // Keep the chain alive even if this write rejects, so later writes still fire.
  photoLibraryWriteChain = run.then( ( ) => undefined, ( ) => undefined );
  return run;
};

// A hung deletePhotos (confirmation never presents) must not block the chain
// forever, or one bad call poisons every later deletion for the whole session.
//
// This used to be 120s, sized to let a real user read and answer the iOS
// confirmation. Nothing in any log has ever answered one: every hang on record
// ran the full two minutes and came back with nothing, holding the write chain
// — and the screen the user asked to leave — for the whole of it. Ten seconds
// is the cost of finding out instead. The trade is real and deliberate: a user
// who takes longer than 10s to tap Delete gets a failure reported for a
// deletion iOS may still carry out behind it.
const DELETE_TIMEOUT_MS = 10000;

// The pending-delete diagnostic has to land while the delete is still in
// flight, so it is a fraction of the budget above rather than a fixed 20s that
// would now never be reached.
const HANG_REPORT_MS = DELETE_TIMEOUT_MS / 2;

// How long a consent-free library write gets before the library counts as
// unhealthy. Creating an album is a local database write; on a working library
// it comes back in milliseconds, so anything near this is already pathological.
const PREFLIGHT_TIMEOUT_MS = 10000;

// Runs one Photos-library transaction that needs no user consent (creating an
// album and deleting it again) immediately before the deletion, with nothing
// else in flight.
//
// This settles the question the 20s hang probe couldn't. That probe runs
// *concurrently* with the hung deletion, so when it hangs too — as it did on
// its first sighting, Aug 5 04:30 — the result is ambiguous between "the whole
// library is wedged" and "transactions are just queueing behind the dead
// deletion". Running the same transaction before the deletion removes the
// second explanation: nothing is in flight to queue behind — which was only
// ever true of writes that go through enqueuePhotoLibraryWrite, and the USB
// card offload did not, so the Aug 5 16:08 preflight ran on top of a live
// saveImageToPhotos and its verdict meant nothing. Every native library write
// is on the chain now; add one off it and this probe goes back to being
// unreadable.
//
// It is also a fix, not only a measurement. A library that can't complete a
// write the app owns outright certainly can't complete a deletion that needs a
// consent alert on top, and every delete in the Aug 5 log spent 120s
// discovering that. Skipping on a failed preflight turns a two-minute hang into
// a ten-second one. It is judged fresh on every deletion, so the next import
// tries again rather than being locked out by this one's verdict.
const preflightPhotoLibraryWrite = async (
  requested: number,
): Promise<{ ok: boolean; ms: number }> => {
  if ( Platform.OS !== "ios" || !ImageCropper?.photoLibraryWriteProbe ) {
    return { ok: true, ms: -1 };
  }
  const startedAt = Date.now( );
  const probe = await Promise.race( [
    ImageCropper.photoLibraryWriteProbe( ).catch(
      probeError => ( { ok: false, ms: -1, error: String( probeError ) } ),
    ),
    new Promise<null>( resolve => { setTimeout( ( ) => resolve( null ), PREFLIGHT_TIMEOUT_MS ); } ),
  ] );
  const ok = probe?.ok ?? false;
  // Only reported when it fails or drags. A healthy preflight is the common
  // case and says nothing the deletion that follows doesn't already say, and
  // one remote POST per delete is what the last round of removals was about.
  //
  // A drag is not an error, though: the Aug 5 22:04 probe took 5807ms, came
  // back ok, and the 463-photo deletion behind it worked. Reporting that at
  // error level puts a healthy library at the top of an errors-first triage.
  // Only a probe that did not complete is an error.
  if ( !ok || Date.now( ) - startedAt > 1000 ) {
    const report = ok
      ? logger.infoWithExtra
      : logger.errorWithExtra;
    report( "photo_delete_preflight", {
      requested,
      probeOk: ok,
      probeMs: probe?.ms ?? -1,
      waitedMs: Date.now( ) - startedAt,
      // Albums left behind by earlier probes, cleaned up by this one's single
      // transaction. Anything above 1 means probes have been landing their
      // write and being reported as failures anyway.
      probeCleaned: probe?.cleaned ?? -1,
      probeError: probe === null
        ? `consent-free library write did not settle in ${PREFLIGHT_TIMEOUT_MS}ms`
        : probe.error,
    } );
  }
  return {
    ok,
    ms: ok
      ? Date.now( ) - startedAt
      : -1,
  };
};

const performDeleteOriginalDevicePhotos = async (
  photoUris: string[],
  options: DeleteOriginalDevicePhotosOptions = {},
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

  const preflight = await preflightPhotoLibraryWrite( requested );
  if ( !preflight.ok ) {
    // No prose line beside this: photo_delete_preflight above already carries
    // the count and why it failed, and two POSTs for one event is what the
    // last round of removals was about.
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
    backgrounded,
    wentInactive,
    appStateChanges,
    appState: typeof AppState.currentState === "string"
      ? AppState.currentState
      : "unknown",
    hangsThisSession: photoLibraryWriteHangCount,
    msSinceLastSuccess: lastPhotoLibraryWriteSuccessAt === null
      ? -1
      : Date.now( ) - lastPhotoLibraryWriteSuccessAt,
    // How long the consent-free write immediately before this delete took, on
    // the same library, with nothing else in flight (-1 = the probe wasn't
    // available; a failed probe skips the delete entirely, so it can't reach
    // here). A hang carrying a fast preflight is the case that matters: it
    // says the library was demonstrably servicing writes moments earlier and
    // wedged on the ask. Folded in here rather than logged separately because
    // a healthy preflight isn't worth a POST of its own.
    preflightMs: preflight.ms,
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
      // Alongside the context, run one Photos-library transaction that needs no
      // user confirmation (photoLibraryWriteProbe in ImageCropper.m). Every hang
      // in the Aug 4 log reported a foreground app, a live scene, no modal,
      // every asset fetched and a main queue answering in 8ms — so the question
      // left is whether PHPhotoLibrary itself is dead or only the consent alert
      // a deletion needs. A probe that comes back while the delete beside it
      // never does answers that. Deliberately not routed through
      // enqueuePhotoLibraryWrite: running concurrently with the hung delete is
      // the whole point. (Which does mean a probe that also hangs is ambiguous
      // between a wedged library and transactions queueing behind the dead one
      // — preflightPhotoLibraryWrite above is what disambiguates it, since a
      // delete only gets this far once the same write succeeded with nothing
      // in flight.)
      //
      // Bounded separately rather than as one Promise.all, so a probe that
      // hangs can't make the context read as "the main queue never answered",
      // which is a different diagnosis entirely.
      let contextRespondedIn = -1;
      const boundedContext = Promise.race( [
        ImageCropper.photoDeletionContext( uniqueUris ).then( context => {
          contextRespondedIn = Date.now( ) - askedAt;
          return context;
        } ),
        new Promise<null>( resolve => { setTimeout( ( ) => resolve( null ), 5000 ); } ),
      ] ).catch( ( ) => null );
      const boundedProbe = ImageCropper.photoLibraryWriteProbe
        ? Promise.race( [
          ImageCropper.photoLibraryWriteProbe( ).catch(
            probeError => ( { ok: false, ms: -1, error: String( probeError ) } ),
          ),
          new Promise<null>( resolve => { setTimeout( ( ) => resolve( null ), 10000 ); } ),
        ] )
        : Promise.resolve( null );
      void Promise.all( [boundedContext, boundedProbe] ).then(
        ( [contextAtHang, probe] ) => logger.errorWithExtra( "photo_delete_hang_context", {
          requested,
          mainQueueResponsive: contextAtHang !== null,
          msToRespond: contextRespondedIn,
          contextAtHang: contextAtHang ?? "main queue did not respond in 5000ms",
          // A consent-free library write, concurrent with the hung deletion.
          probeOk: probe?.ok ?? false,
          probeMs: probe?.ms ?? -1,
          probeError: probe === null
            ? "consent-free library write did not settle in 10000ms"
            : probe.error,
        } ),
      ).catch( ( ) => undefined );
    }
  }, HANG_REPORT_MS );
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
    const result = await Promise.race( [
      deletion,
      new Promise( ( _resolve, reject ) => {
        timeoutTimer = setTimeout(
          ( ) => reject( new Error( `deletePhotos timed out after ${DELETE_TIMEOUT_MS}ms` ) ),
          DELETE_TIMEOUT_MS,
        );
      } ),
    ] );
    // Report what the OS actually deleted, not what we asked for. A call that
    // resolves with deleted:0 (e.g. fetched:0 — every URI is a ghost pointing
    // at an already-deleted asset) is a no-op, and logging it as a deletion of
    // all N made a repeating no-op look like a working cleanup.
    const deleted = ( result as { deleted?: number } | undefined )?.deleted;
    logger.info(
      `Deleted ${deleted ?? requested} of ${requested} `
      + `device photo(s); result=${JSON.stringify( result )}`,
    );
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
    recordPhotoLibraryWriteSuccess( );
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
  ( ) => performDeleteOriginalDevicePhotos( photoUris, options ),
);

// Callers hold the user on the current screen until onComplete fires so the
// iOS deletion confirmation isn't asked to present mid-navigation. A deletion
// normally settles in a couple of seconds, and a wedged one now gives up after
// DELETE_TIMEOUT_MS. This stays above that: a delete queued behind another
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
