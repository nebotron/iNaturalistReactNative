import { format } from "date-fns";
import type Realm from "realm";
import type { RealmObservation } from "realmModels/types";
import { getDevicePhotoUrisFromObservation } from "sharedHelpers/duplicateUploadedDevicePhotos";

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

// Finds every device photo library URI that belongs to an observation which
// the current user has NOT favorited, grouped by the day the observation was
// made. Returns the groups sorted newest day first.
const findUnfavoritedDevicePhotoDays = (
  realm: Realm,
): UnfavoritedPhotoDay[] => {
  const observations = realm.objects<FavoritableObservation>( "Observation" );
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
