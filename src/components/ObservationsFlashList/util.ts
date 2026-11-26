// Helpers for working with Realm or API records
import type { ApiObservation } from "api/types";
import Sound from "realmModels/Sound";
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
  const photos = ( observation as RealmObservation )?.observationPhotos?.map( op => op.photo )
    ?? ( observation as ApiObservation )?.observation_photos?.map( op => op.photo )
    ?? [];
  return photos.filter( Boolean );
}

export function observationHasSound( observation: ApiObservation | RealmObservation ) {
  return !!(
    ( observation as RealmObservation )?.observationSounds?.length
    || ( observation as ApiObservation )?.observation_sounds?.length
  );
}

// Playable URI of the observation's first sound, local file if there is one
export function soundUriFromObservation( observation?: ApiObservation | RealmObservation ) {
  const sound = ( observation as RealmObservation )?.observationSounds?.[0]?.sound
    || ( observation as ApiObservation )?.observation_sounds?.[0]?.sound;
  const url = sound?.file_url;
  return url
    ? Sound.getLocalSoundUri( url ) || url
    : undefined;
}
