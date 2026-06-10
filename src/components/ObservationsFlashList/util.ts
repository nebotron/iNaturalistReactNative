// Helpers for working with Realm or API records
import type { ApiObservation } from "api/types";
import type { RealmObservation } from "realmModels/types";

export function photoFromObservation( observation?: ApiObservation | RealmObservation ) {
  return ( observation as RealmObservation )?.observationPhotos?.[0]?.photo
    || ( observation as ApiObservation )?.observation_photos?.[0]?.photo
    || null;
}

export function photoCountFromObservation( observation: ApiObservation | RealmObservation ) {
  return ( observation as RealmObservation )?.observationPhotos?.length
    || ( observation as ApiObservation )?.observation_photos?.length
    || 0;
}

export function photosFromObservation( observation?: ApiObservation | RealmObservation ) {
  const realmPhotos = ( observation as RealmObservation )?.observationPhotos
    ?.map( op => op.photo )
    ?.filter( Boolean );
  if ( realmPhotos?.length ) {
    return realmPhotos;
  }
  return ( observation as ApiObservation )?.observation_photos
    ?.map( op => op.photo )
    ?.filter( Boolean )
    ?? [];
}

export function observationHasSound( observation: ApiObservation | RealmObservation ) {
  return !!(
    ( observation as RealmObservation )?.observationSounds?.length
    || ( observation as ApiObservation )?.observation_sounds?.length
  );
}
