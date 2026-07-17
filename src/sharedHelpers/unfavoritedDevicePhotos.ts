import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import { format } from "date-fns";
import { Platform } from "react-native";
import type Realm from "realm";
import type { RealmObservation } from "realmModels/types";
import { getDevicePhotoUrisFromObservation } from "sharedHelpers/duplicateUploadedDevicePhotos";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";

// RealmObservation's type doesn't surface votes/faves, but both exist at
// runtime (see realmModels/Observation.js), so widen the type here.
type FavoritableObservation = RealmObservation & {
  faves?: ( ) => unknown[];
  votes?: ( { vote_scope?: string | null } | null )[];
};

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

// How many library assets to request per page. The library is paged through
// in full so even the oldest photos are considered (see below).
const LIBRARY_PAGE_SIZE = 1000;

// An observation is favorited when it has at least one vote with a null scope.
const isFavorited = ( observation: FavoritableObservation ): boolean => {
  if ( typeof observation.faves === "function" ) {
    return observation.faves( ).length > 0;
  }
  const votes = observation.votes ?? [];
  return votes.filter( vote => vote?.vote_scope === null ).length > 0;
};

const getObservationDate = ( observation: RealmObservation ): Date => {
  const raw = observation.time_observed_at
    || observation.observed_on
    || observation._created_at;
  const date = raw
    ? new Date( raw )
    : null;
  if ( date && !Number.isNaN( date.getTime( ) ) ) {
    return date;
  }
  return new Date( 0 );
};

// Normalized device-library URI for a CameraRoll node, matching the form we
// persist in ObservationPhoto.originalDevicePhotoUri.
const nodeDeviceUri = (
  node: { id?: string; image?: { uri?: string } },
): string | null => {
  if ( Platform.OS === "ios" && node.id ) {
    return normalizeDevicePhotoUri( `ph://${node.id}` );
  }
  return normalizeDevicePhotoUri( node.image?.uri );
};

// Builds the set of device-library URIs that STILL EXIST on device by paging
// through the entire photo library. Returns null if the library can't be read
// (e.g. permission denied), signalling callers not to filter on existence.
// Full pagination matters: reading only the first (newest) page would make
// older-but-still-present photos look deleted and hide them.
const fetchExistingDeviceUris = async ( ): Promise<Set<string> | null> => {
  try {
    const existing = new Set<string>( );
    let after: string | undefined;
    let hasNextPage = true;
    while ( hasNextPage ) {
      // eslint-disable-next-line no-await-in-loop
      const result = await CameraRoll.getPhotos( {
        first: LIBRARY_PAGE_SIZE,
        assetType: "Photos",
        after,
      } );
      result.edges.forEach( ( { node } ) => {
        const uri = nodeDeviceUri( node );
        if ( uri ) {
          existing.add( uri );
        }
      } );
      hasNextPage = result.page_info.has_next_page;
      after = result.page_info.end_cursor;
    }
    return existing;
  } catch {
    return null;
  }
};

// Finds every device photo library URI that belongs to an observation which
// the current user has NOT favorited AND still exists in the device photo
// library, grouped by the day the observation was made. Returns the groups
// sorted newest day first.
const findUnfavoritedDevicePhotoDays = async (
  realm: Realm,
): Promise<UnfavoritedPhotoDay[]> => {
  const observations = realm.objects<FavoritableObservation>( "Observation" );
  const existingDeviceUris = await fetchExistingDeviceUris( );
  const seenUris = new Set<string>( );
  const dayMap = new Map<string, UnfavoritedPhotoDay>( );

  observations.forEach( observation => {
    if ( isFavorited( observation ) ) {
      return;
    }
    const uris = getDevicePhotoUrisFromObservation( observation );
    if ( uris.length === 0 ) {
      return;
    }
    const date = getObservationDate( observation );
    const dateKey = format( date, "yyyy-MM-dd" );
    uris.forEach( uri => {
      if ( seenUris.has( uri ) ) {
        return;
      }
      // Skip photos the user has already deleted from their device library.
      if ( existingDeviceUris && !existingDeviceUris.has( uri ) ) {
        return;
      }
      seenUris.add( uri );
      const existing = dayMap.get( dateKey );
      if ( existing ) {
        existing.uris.push( uri );
      } else {
        dayMap.set( dateKey, {
          dateKey,
          label: format( date, "MMMM d, yyyy" ),
          timestamp: new Date( date.getFullYear( ), date.getMonth( ), date.getDate( ) ).getTime( ),
          uris: [uri],
        } );
      }
    } );
  } );

  return Array.from( dayMap.values( ) ).sort( ( a, b ) => b.timestamp - a.timestamp );
};

export default findUnfavoritedDevicePhotoDays;
