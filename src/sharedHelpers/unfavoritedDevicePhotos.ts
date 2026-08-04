import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import { format } from "date-fns";
import { NativeModules, Platform } from "react-native";
import type Realm from "realm";
import type { RealmObservation } from "realmModels/types";
import { getDevicePhotoUrisFromObservation } from "sharedHelpers/duplicateUploadedDevicePhotos";
import filterExistingDevicePhotoUris from "sharedHelpers/existingDevicePhotoUris";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import { log } from "sharedHelpers/logger";
import {
  clearRemovedGroupPhotoUris,
  getRemovedGroupPhotoUris,
} from "sharedHelpers/removedGroupPhotoUris";
import type { UserObservationsCache } from "sharedHelpers/userObservationsCache";

const logger = log.extend( "unfavoritedDevicePhotos" );

// RealmObservation's type doesn't surface votes/faves, but both exist at
// runtime (see realmModels/Observation.js), so widen the type here.
type FavoritableObservation = RealmObservation & {
  faves?: ( ) => unknown[];
  votes?: ( { vote_scope?: string | null } | null )[];
};

type PhotoNode = PhotoIdentifier["node"];

export interface UnfavoritedPhotoDay {
  // Stable key for the day, e.g. "2026-07-16"
  dateKey: string;
  // Human readable header, e.g. "July 16, 2026"
  label: string;
  // Milliseconds at the start of the day, used for sorting newest-first
  timestamp: number;
  // Device photo library URIs (ph:// on iOS) taken on this day
  uris: string[];
}

// A device photo is treated as belonging to an observation only when their
// capture times are identical. Older observations (created before we stored a
// device photo URI) have no exact link to their library asset, so we fall back
// to matching on capture time. Both sides are compared at whole-second
// precision (EXIF timestamps have no sub-second component), so this is an exact
// same-second match with zero tolerance.
const CAPTURE_TIME_TOLERANCE_MS = 0;

// The library scan query bounds are padded slightly wider than the observation
// range so a photo sitting exactly on a boundary isn't excluded by the query
// (fromTime/toTime range semantics) before it can be matched. Matching itself
// stays exact.
const SCAN_PADDING_MS = 1000;

const toWholeSecondMs = ( ms: number ): number => Math.floor( ms / 1000 ) * 1000;

// Each page is a separate round trip to the native photo library, and the
// per-page overhead dwarfs the cost of the extra assets, so ask for a lot at a
// time: a 20k-photo window is 20 calls instead of 200.
const PAGE_SIZE = 1000;
// Safety valve so an enormous library can't loop forever.
const MAX_PAGES = 20;

// An observation is favorited when it has at least one vote with a null scope.
const isFavorited = ( observation: FavoritableObservation ): boolean => {
  if ( typeof observation.faves === "function" ) {
    return observation.faves( ).length > 0;
  }
  const votes = observation.votes ?? [];
  return votes.filter( vote => vote?.vote_scope === null ).length > 0;
};

const getObservationTimeMs = ( observation: RealmObservation ): number | null => {
  const raw = observation.time_observed_at
    || observation.observed_on
    || observation._created_at;
  if ( !raw ) {
    return null;
  }
  const time = new Date( raw ).getTime( );
  return Number.isNaN( time )
    ? null
    : toWholeSecondMs( time );
};

const deviceUriFromAssetNode = ( node: PhotoNode ): string | null => {
  if ( Platform.OS === "ios" && node.id ) {
    return normalizeDevicePhotoUri( `ph://${node.id}` );
  }
  return normalizeDevicePhotoUri( node.image?.uri );
};

// True when `sortedTimes` (ascending) contains a value within `tolerance` of `t`.
const hasTimeWithinTolerance = (
  sortedTimes: number[],
  t: number,
  tolerance: number,
): boolean => {
  if ( sortedTimes.length === 0 ) {
    return false;
  }
  let lo = 0;
  let hi = sortedTimes.length;
  while ( lo < hi ) {
    const mid = Math.floor( ( lo + hi ) / 2 );
    if ( sortedTimes[mid] < t ) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  // The nearest value is at lo (first >= t) or lo - 1 (last < t).
  const neighbors = [];
  if ( lo < sortedTimes.length ) {
    neighbors.push( sortedTimes[lo] );
  }
  if ( lo > 0 ) {
    neighbors.push( sortedTimes[lo - 1] );
  }
  return neighbors.some( neighbor => Math.abs( neighbor - t ) <= tolerance );
};

interface DeviceAsset {
  uri: string;
  timestampMs: number | null;
}

interface NativePhotoMatcher {
  photoAssetsMatchingCaptureTimes?: (
    captureTimesMs: number[],
    fromTime: number | null,
    toTime: number | null,
  ) => Promise<{ uris?: string[]; timestamps?: number[]; scanned?: number }>;
}

// Asks the Photos framework for the assets whose capture second matches one of
// the observation times, so only those cross the bridge. Returns null when the
// native helper can't answer (Android, an older build, no library access), in
// which case the caller pages CameraRoll instead.
const loadMatchingDeviceAssets = async (
  times: number[],
  fromTime: number | undefined,
  toTime: number | undefined,
): Promise<DeviceAsset[] | null> => {
  // Read at call time rather than at import so a test (and a build without the
  // method) can be told apart from a build that has it.
  const { ImageCropper } = NativeModules as { ImageCropper?: NativePhotoMatcher };
  if ( Platform.OS !== "ios" || !ImageCropper?.photoAssetsMatchingCaptureTimes ) {
    return null;
  }
  const startedAt = Date.now( );
  try {
    const result = await ImageCropper.photoAssetsMatchingCaptureTimes(
      times,
      fromTime ?? null,
      toTime ?? null,
    );
    const uris = result?.uris;
    if ( !Array.isArray( uris ) ) {
      return null;
    }
    const timestamps = result?.timestamps ?? [];
    logger.info(
      `Matched ${uris.length} of ${result?.scanned ?? 0} library photo(s) `
      + `against ${times.length} observation time(s) in ${Date.now( ) - startedAt}ms`,
    );
    return uris.map( ( uri, index ) => ( {
      uri: normalizeDevicePhotoUri( uri ) ?? uri,
      timestampMs: typeof timestamps[index] === "number"
        ? timestamps[index]
        : null,
    } ) );
  } catch ( error ) {
    logger.warn( "Falling back to a CameraRoll scan of the photo library", error );
    return null;
  }
};

// Pulls every photo from the device library within the given time window,
// paginating through CameraRoll. Returns an empty list if the library can't be
// read (e.g. permission denied), in which case only exact URI matches surface.
const loadDeviceAssetsFromCameraRoll = async (
  fromTime: number | undefined,
  toTime: number | undefined,
): Promise<DeviceAsset[]> => {
  const assets: DeviceAsset[] = [];
  let after: string | undefined;
  let pages = 0;
  try {
    let hasNextPage = true;
    while ( hasNextPage && pages < MAX_PAGES ) {
      pages += 1;
      // eslint-disable-next-line no-await-in-loop
      const result = await CameraRoll.getPhotos( {
        first: PAGE_SIZE,
        assetType: "Photos",
        after,
        fromTime,
        toTime,
      } );
      result.edges.forEach( ( { node } ) => {
        const uri = deviceUriFromAssetNode( node );
        if ( !uri ) {
          return;
        }
        assets.push( {
          uri,
          timestampMs: typeof node.timestamp === "number"
            ? toWholeSecondMs( node.timestamp * 1000 )
            : null,
        } );
      } );
      hasNextPage = result.page_info.has_next_page && !!result.page_info.end_cursor;
      after = result.page_info.end_cursor;
    }
  } catch ( error ) {
    logger.error( "Failed to read device photo library", error );
  }
  return assets;
};

// What a library scan found, plus which capture times it was matched against.
// A time-filtered scan only speaks for the times it was given, so a caller that
// learns about more of them afterwards (the prefetch below starts before the
// observation sync lands) knows exactly what it still has to ask for.
export interface DeviceAssetScan {
  assets: DeviceAsset[];
  // Null when the scan wasn't filtered by time and so covers its whole window.
  matchedTimes: Set<number> | null;
}

interface ScanBounds {
  fromTime: number | undefined;
  toTime: number | undefined;
}

// Bound the library scan to the era spanned by the user's observations.
// Undefined bounds mean "scan everything", which is what we want when no
// observation has a usable time.
const getScanBounds = ( times: number[] ): ScanBounds => {
  let fromTime: number | undefined;
  let toTime: number | undefined;
  times.forEach( t => {
    if ( fromTime === undefined || t < fromTime ) {
      fromTime = t;
    }
    if ( toTime === undefined || t > toTime ) {
      toTime = t;
    }
  } );
  if ( fromTime !== undefined && toTime !== undefined ) {
    fromTime -= SCAN_PADDING_MS;
    toTime += SCAN_PADDING_MS;
  }
  return { fromTime, toTime };
};

// Finds the library photos that could belong to an observation taken at one of
// `times`, natively where possible and by paging CameraRoll otherwise.
const scanDeviceAssets = async ( times: number[] ): Promise<DeviceAssetScan> => {
  // Observations cluster on the same second (a burst of photos, a day's
  // uploads), and there's no point sending the same one across the bridge twice.
  const wanted = new Set( times );
  if ( wanted.size === 0 ) {
    return { assets: [], matchedTimes: wanted };
  }
  const { fromTime, toTime } = getScanBounds( times );
  const matched = await loadMatchingDeviceAssets( [...wanted], fromTime, toTime );
  if ( matched ) {
    return { assets: matched, matchedTimes: wanted };
  }
  return {
    assets: await loadDeviceAssetsFromCameraRoll( fromTime, toTime ),
    matchedTimes: null,
  };
};

// Starts the device library scan without waiting on anything else. The window
// it scans depends only on when the user's observations were made, not on which
// are favorited, so this can run concurrently with the observation sync that has
// to finish before matching can start — two multi-second waits become one.
// Hand the result to findUnfavoritedDevicePhotoDays.
//
// The scan has to cover the same times matching will consider, so they're taken
// from the last synced cache as well as Realm. Whatever the sync then adds is
// picked up by findUnfavoritedDevicePhotoDays' top-up pass, so a stale cache
// costs a small second scan rather than missing photos.
export const prefetchDeviceAssets = (
  realm: Realm,
  observationsCache?: UserObservationsCache,
): Promise<DeviceAssetScan> => {
  const times: number[] = [];
  realm.objects<RealmObservation>( "Observation" ).forEach( observation => {
    const timeMs = getObservationTimeMs( observation );
    if ( timeMs !== null ) {
      times.push( timeMs );
    }
  } );
  observationsCache?.forEach( cached => {
    if ( cached.observedAtMs !== null ) {
      times.push( cached.observedAtMs );
    }
  } );
  return scanDeviceAssets( times );
};

const addUriToDay = (
  dayMap: Map<string, UnfavoritedPhotoDay>,
  uri: string,
  timeMs: number | null,
): void => {
  const date = timeMs !== null
    ? new Date( timeMs )
    : new Date( 0 );
  const dateKey = format( date, "yyyy-MM-dd" );
  const existing = dayMap.get( dateKey );
  if ( existing ) {
    existing.uris.push( uri );
    return;
  }
  dayMap.set( dateKey, {
    dateKey,
    label: format( date, "MMMM d, yyyy" ),
    timestamp: new Date(
      date.getFullYear( ),
      date.getMonth( ),
      date.getDate( ),
    ).getTime( ),
    uris: [uri],
  } );
};

// Removes URIs that no longer resolve to a real library asset. A stored device
// photo URI outlives its photo: once the asset is deleted (by an earlier
// cleanup run, or by the user in Photos) or orphaned by a device restore, the
// identifier is a ghost. It renders as a blank thumbnail and the OS can't
// delete it, so keeping it only inflates the count past what a delete can
// actually do.
const dropVanishedUris = async (
  days: UnfavoritedPhotoDay[],
): Promise<UnfavoritedPhotoDay[]> => {
  const allUris = days.flatMap( day => day.uris );
  const existing = new Set( await filterExistingDevicePhotoUris( allUris ) );
  const vanished = allUris.filter( uri => !existing.has( uri ) );
  if ( vanished.length === 0 ) {
    return days;
  }
  // Group Photos removals confirmed gone from the library have nothing left to
  // clean up, so stop carrying them forward (see removedGroupPhotoUris.ts).
  clearRemovedGroupPhotoUris( vanished );
  return days
    .map( day => ( { ...day, uris: day.uris.filter( uri => existing.has( uri ) ) } ) )
    .filter( day => day.uris.length > 0 );
};

// Finds every device photo library URI that belongs to an observation the
// current user has NOT favorited, grouped by the day the photo was taken.
// Photos are matched two ways: exactly, via the device photo URI stored on the
// observation, and heuristically, by comparing the photo's capture time to the
// observation's time (so older observations that predate URI tracking are still
// found). Photos belonging to favorited observations are always protected.
// Returns the groups sorted newest day first.
const findUnfavoritedDevicePhotoDays = async (
  realm: Realm,
  prefetchedAssets?: Promise<DeviceAssetScan>,
  observationsCache?: UserObservationsCache,
): Promise<UnfavoritedPhotoDay[]> => {
  const observations = realm.objects<FavoritableObservation>( "Observation" );

  const unfavoritedTimes: number[] = [];
  const favoritedTimes: number[] = [];
  const exactUnfavoritedUris = new Set<string>( );
  const exactFavoritedUris = new Set<string>( );
  const unfavoritedUriTime = new Map<string, number | null>( );
  const seenUuids = new Set<string>( );

  observations.forEach( observation => {
    // Realm only holds the most recent page of remote observations, so its
    // votes are both incomplete and potentially stale. Prefer the shared cache,
    // which covers the whole history, and fall back to Realm for observations
    // it doesn't know about — anything created on this device and not yet
    // uploaded, which can't be favorited anyway.
    const cached = observation.uuid
      ? observationsCache?.get( observation.uuid )
      : undefined;
    if ( observation.uuid ) {
      seenUuids.add( observation.uuid );
    }
    const favorited = cached?.faved ?? isFavorited( observation );
    const timeMs = getObservationTimeMs( observation );
    const uris = getDevicePhotoUrisFromObservation( observation );
    if ( favorited ) {
      if ( timeMs !== null ) {
        favoritedTimes.push( timeMs );
      }
      uris.forEach( uri => exactFavoritedUris.add( uri ) );
    } else {
      if ( timeMs !== null ) {
        unfavoritedTimes.push( timeMs );
      }
      uris.forEach( uri => {
        exactUnfavoritedUris.add( uri );
        if ( !unfavoritedUriTime.has( uri ) ) {
          unfavoritedUriTime.set( uri, timeMs );
        }
      } );
    }
  } );

  // Observations that aren't in Realm can't contribute a device photo URI, but
  // their capture times still decide whether a library photo belongs to
  // something favorited. Without them the whole pre-Realm history was invisible
  // here: its photos were never offered for deletion, and — the part that
  // matters — a favorited observation from back then couldn't protect its photo.
  observationsCache?.forEach( cached => {
    if ( seenUuids.has( cached.uuid ) || cached.observedAtMs === null ) {
      return;
    }
    if ( cached.faved ) {
      favoritedTimes.push( cached.observedAtMs );
    } else {
      unfavoritedTimes.push( cached.observedAtMs );
    }
  } );

  // A photo favorited on one observation wins over an unfavorited match.
  exactFavoritedUris.forEach( uri => exactUnfavoritedUris.delete( uri ) );

  // Photos the user already chose to remove via Group Photos, whose device
  // deletion may have silently failed (see removedGroupPhotoUris.ts). These
  // don't need the library-scan matching below — they're already known exact
  // URIs — so they're handled up front and merged back in either way.
  const pendingRemovedGroupPhotoUris = getRemovedGroupPhotoUris( );

  if ( unfavoritedTimes.length === 0 && exactUnfavoritedUris.size === 0 ) {
    return pendingRemovedGroupPhotoUris.length > 0
      ? dropVanishedUris( [{
        dateKey: "removed-from-group-photos",
        label: "Removed from Group Photos",
        timestamp: Date.now( ),
        uris: pendingRemovedGroupPhotoUris,
      }] )
      : [];
  }

  unfavoritedTimes.sort( ( a, b ) => a - b );
  favoritedTimes.sort( ( a, b ) => a - b );

  const allTimes = [...unfavoritedTimes, ...favoritedTimes];
  const scan = await ( prefetchedAssets ?? scanDeviceAssets( allTimes ) );
  const assets = [...scan.assets];
  // A prefetch starts before the sync lands, so it could only match against the
  // times known then. Anything the sync added (an observation made on another
  // device, or a fave toggled there) needs a second pass — normally a handful
  // of times, and nothing at all on the common path where nothing changed.
  const scannedTimes = scan.matchedTimes;
  if ( scannedTimes ) {
    const missedTimes = allTimes.filter( time => !scannedTimes.has( time ) );
    if ( missedTimes.length > 0 ) {
      assets.push( ...( await scanDeviceAssets( missedTimes ) ).assets );
    }
  }

  const dayMap = new Map<string, UnfavoritedPhotoDay>( );
  const seenUris = new Set<string>( );
  // Capture times already represented by a live library asset, so a stale
  // stored URI for the same moment (e.g. a local identifier orphaned by a
  // device restore) isn't also added as a second, undeletable "match".
  const matchedTimes = new Set<number>( );

  assets.forEach( ( { uri, timestampMs } ) => {
    if ( seenUris.has( uri ) || exactFavoritedUris.has( uri ) ) {
      return;
    }
    const isExactUnfavorited = exactUnfavoritedUris.has( uri );
    if ( timestampMs !== null ) {
      // Protect anything sharing a favorited observation's capture time, unless
      // this exact photo is explicitly linked to an unfavorited one.
      const nearFavorited = hasTimeWithinTolerance(
        favoritedTimes,
        timestampMs,
        CAPTURE_TIME_TOLERANCE_MS,
      );
      if ( nearFavorited && !isExactUnfavorited ) {
        return;
      }
      const nearUnfavorited = hasTimeWithinTolerance(
        unfavoritedTimes,
        timestampMs,
        CAPTURE_TIME_TOLERANCE_MS,
      );
      if ( !isExactUnfavorited && !nearUnfavorited ) {
        return;
      }
    } else if ( !isExactUnfavorited ) {
      // No capture time to compare, so only keep known exact matches.
      return;
    }
    seenUris.add( uri );
    addUriToDay( dayMap, uri, timestampMs );
    if ( timestampMs !== null ) {
      matchedTimes.add( timestampMs );
    }
  } );

  // Make sure exact matches always appear, even if the library scan missed
  // them (permission denied, or the asset's capture time matches no observation
  // and so fell outside what the scan asked for).
  // Skip ones whose capture time is already covered by a live asset above —
  // that's the same physical photo under its current identifier, not a
  // second photo, so counting the stored URI too would double it.
  exactUnfavoritedUris.forEach( uri => {
    if ( seenUris.has( uri ) ) {
      return;
    }
    const timeMs = unfavoritedUriTime.get( uri ) ?? null;
    if ( timeMs !== null && matchedTimes.has( timeMs ) ) {
      return;
    }
    seenUris.add( uri );
    addUriToDay( dayMap, uri, timeMs );
  } );

  // Give cleanup another shot at these regardless of favorite status — the
  // user already decided they should go — grouped separately since we don't
  // have a capture time for them without a per-asset library lookup.
  const removedGroupPhotoUris = pendingRemovedGroupPhotoUris
    .filter( uri => !seenUris.has( uri ) );
  if ( removedGroupPhotoUris.length > 0 ) {
    dayMap.set( "removed-from-group-photos", {
      dateKey: "removed-from-group-photos",
      label: "Removed from Group Photos",
      // Sorts to the top (newest-first) regardless of when these were taken.
      timestamp: Date.now( ),
      uris: removedGroupPhotoUris,
    } );
  }

  return dropVanishedUris(
    Array.from( dayMap.values( ) ).sort( ( a, b ) => b.timestamp - a.timestamp ),
  );
};

export default findUnfavoritedDevicePhotoDays;
