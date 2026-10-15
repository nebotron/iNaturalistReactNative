import type Realm from "realm";
import type { RealmObservation } from "realmModels/types";
import { getDevicePhotoUrisFromObservation } from "sharedHelpers/duplicateUploadedDevicePhotos";
import filterExistingDevicePhotoUris from "sharedHelpers/existingDevicePhotoUris";
import {
  clearRemovedGroupPhotoUris,
  getRemovedGroupPhotoUris,
} from "sharedHelpers/removedGroupPhotoUris";
import type { UserObservationsCache } from "sharedHelpers/userObservationsCache";

// RealmObservation's type doesn't surface votes/faves, but both exist at
// runtime (see realmModels/Observation.js), so widen the type here.
type FavoritableObservation = RealmObservation & {
  faves?: ( ) => unknown[];
  votes?: ( { vote_scope?: string | null } | null )[];
};

// An observation is favorited when it has at least one vote with a null scope.
const isFavorited = ( observation: FavoritableObservation ): boolean => {
  if ( typeof observation.faves === "function" ) {
    return observation.faves( ).length > 0;
  }
  const votes = observation.votes ?? [];
  return votes.filter( vote => vote?.vote_scope === null ).length > 0;
};

// Finds every device photo library URI stored on an observation the current
// user has NOT favorited, plus photos already removed via Group Photos. Matching
// is by stored URI only. A photo also stored on a favorited observation is
// protected. URIs that no longer resolve to a library asset are dropped.
const findUnfavoritedDevicePhotoUris = async (
  realm: Realm,
  observationsCache?: UserObservationsCache,
): Promise<string[]> => {
  const unfavoritedUris = new Set<string>( );
  const favoritedUris = new Set<string>( );

  realm.objects<FavoritableObservation>( "Observation" ).forEach( observation => {
    // Realm's votes can be stale; prefer the shared cache, which is reconciled
    // with the server on every open.
    const cached = observation.uuid
      ? observationsCache?.get( observation.uuid )
      : undefined;
    const favorited = cached?.faved ?? isFavorited( observation );
    getDevicePhotoUrisFromObservation( observation ).forEach( uri => {
      ( favorited
        ? favoritedUris
        : unfavoritedUris ).add( uri );
    } );
  } );

  favoritedUris.forEach( uri => unfavoritedUris.delete( uri ) );
  // Photos the user already chose to remove via Group Photos, whose device
  // deletion may have silently failed (see removedGroupPhotoUris.ts).
  getRemovedGroupPhotoUris( ).forEach( uri => unfavoritedUris.add( uri ) );

  const allUris = [...unfavoritedUris];
  const existing = await filterExistingDevicePhotoUris( allUris );
  const existingSet = new Set( existing );
  const vanished = allUris.filter( uri => !existingSet.has( uri ) );
  if ( vanished.length > 0 ) {
    clearRemovedGroupPhotoUris( vanished );
  }
  return existing;
};

export default findUnfavoritedDevicePhotoUris;
