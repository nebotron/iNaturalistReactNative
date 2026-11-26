import type { Asset } from "react-native-image-picker";
import type Realm from "realm";
import type { RealmObservation } from "realmModels/types";
import UploadedDevicePhotoUri from "realmModels/UploadedDevicePhotoUri";
import {
  getGalleryAssetDevicePhotoUri,
  normalizeDevicePhotoUri,
} from "sharedHelpers/getOriginalDevicePhotoUri";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";

// getPreviouslyUploadedDevicePhotoUrisSet walks every saved observation's
// photos, and the picker, its preload, Group Photos and each import all ask
// for it, often with nothing
// changed in between (a background burst on build 1122.21 spent 87% of its JS
// samples here). So the full set is kept per Realm and dropped whenever a
// write could change it: Realm's own notifications cover every writer
// (creations and deletions always notify; modifications only for the key path
// read here), and recordUploadedDevicePhotoUris drops it at once, since its
// callers ask again right after it.
const OBSERVATION_URI_KEY_PATHS = ["observationPhotos.originalDevicePhotoUri"];
let uriSetCache: {
  realm: Realm;
  uris: Set<string> | null;
  stopListening: ( ) => void;
} | null = null;

const invalidateUriSetCache = ( realm?: Realm ) => {
  if ( uriSetCache && ( !realm || uriSetCache.realm === realm ) ) uriSetCache.uris = null;
};

// Starts watching a Realm the first time its set is asked for. Returns null for
// a Realm that can't notify (closed, or a test double), which is then always
// walked afresh.
const cacheFor = ( realm: Realm ) => {
  if ( uriSetCache?.realm === realm && !realm.isClosed ) return uriSetCache;
  if ( realm.isClosed || typeof realm.objects( "Observation" )?.addListener !== "function" ) {
    return null;
  }
  uriSetCache?.stopListening( );
  const observations = realm.objects( "Observation" );
  const indexed = realm.objects( UploadedDevicePhotoUri.schema.name );
  // Called once on registration too, which is harmless: nothing is cached yet.
  const invalidate = ( ) => invalidateUriSetCache( realm );
  observations.addListener( invalidate, OBSERVATION_URI_KEY_PATHS );
  indexed.addListener( invalidate );
  uriSetCache = {
    realm,
    uris: null,
    stopListening: ( ) => {
      if ( realm.isClosed ) return;
      observations.removeListener( invalidate );
      indexed.removeListener( invalidate );
    },
  };
  return uriSetCache;
};

export const getDevicePhotoUrisFromObservation = (
  observation: Pick<RealmObservation, "observationPhotos">,
): string[] => (
  ( observation.observationPhotos ?? [] )
    .map( obsPhoto => normalizeDevicePhotoUri( obsPhoto.originalDevicePhotoUri ) )
    .filter( ( uri ): uri is string => !!uri )
);

export const recordUploadedDevicePhotoUris = (
  realm: Realm,
  devicePhotoUris: string[],
): void => {
  // Only URIs not indexed yet. Every save and every upload of an observation
  // records all its photos again, and rewriting a row that's already there
  // (with a fresh uploadedAt) is a disk write that changes nothing anyone
  // reads; with nothing missing, no write transaction is opened at all.
  const missingUris = [...new Set( devicePhotoUris
    .map( normalizeDevicePhotoUri )
    .filter( ( uri ): uri is string => !!uri ) )]
    .filter( uri => !realm.objectForPrimaryKey( UploadedDevicePhotoUri.schema.name, uri ) );

  if ( missingUris.length === 0 ) {
    return;
  }

  invalidateUriSetCache( realm );
  safeRealmWrite( realm, ( ) => {
    const uploadedAt = new Date( );
    missingUris.forEach( uri => {
      realm.create(
        UploadedDevicePhotoUri.schema.name,
        { uri, uploadedAt },
        "modified",
      );
    } );
  }, "recording uploaded device photo URIs" );
};

// Undoes recordUploadedDevicePhotoUris for photos whose import turned out not
// to happen, so a photo that never made it into an observation isn't hidden
// from the picker forever. A photo an *earlier* observation already saved stays
// hidden regardless, since that observation still carries its device URI.
export const forgetUploadedDevicePhotoUris = (
  realm: Realm,
  devicePhotoUris: string[],
): void => {
  const normalizedUris = devicePhotoUris
    .map( normalizeDevicePhotoUri )
    .filter( ( uri ): uri is string => !!uri );

  if ( normalizedUris.length === 0 ) {
    return;
  }

  safeRealmWrite( realm, ( ) => {
    normalizedUris.forEach( uri => {
      const record = realm.objectForPrimaryKey( UploadedDevicePhotoUri.schema.name, uri );
      if ( record ) {
        realm.delete( record );
      }
    } );
  }, "forgetting uploaded device photo URIs" );
};

export const recordUploadedDevicePhotoUrisFromObservation = (
  realm: Realm,
  observation: Pick<RealmObservation, "observationPhotos">,
): void => {
  recordUploadedDevicePhotoUris(
    realm,
    getDevicePhotoUrisFromObservation( observation ),
  );
};

const collectPreviouslyUploadedDevicePhotoUris = (
  realm: Realm,
  excludeObservationUuids: string[],
): Set<string> => {
  const previouslyUploadedUris = new Set<string>( );

  realm.objects<UploadedDevicePhotoUri>( UploadedDevicePhotoUri.schema.name )
    .forEach( record => {
      const uri = normalizeDevicePhotoUri( record.uri );
      if ( uri ) {
        previouslyUploadedUris.add( uri );
      }
    } );

  const savedObservations = realm.objects<RealmObservation>( "Observation" )
    .filtered( "NOT ( uuid IN $0 )", excludeObservationUuids );

  savedObservations.forEach( observation => {
    getDevicePhotoUrisFromObservation( observation ).forEach( uri => {
      previouslyUploadedUris.add( uri );
    } );
  } );

  return previouslyUploadedUris;
};

export const getPreviouslyUploadedDevicePhotoUrisSet = (
  realm: Realm,
  excludeObservationUuids: string[] = [],
): Set<string> => {
  const cache = excludeObservationUuids.length === 0
    ? cacheFor( realm )
    : null;
  if ( !cache ) return collectPreviouslyUploadedDevicePhotoUris( realm, excludeObservationUuids );
  cache.uris ??= collectPreviouslyUploadedDevicePhotoUris( realm, [] );
  // A copy, so a caller adding to its set can't change anyone else's
  return new Set( cache.uris );
};

// The same for a single photo, against a set the caller already has. An import
// that marks its photos one at a time as they land must not walk every saved
// observation once per photo to do it.
export function markDuplicatePhotoFromLibrary<T extends Asset>(
  previouslyUploadedUris: Set<string>,
  photo: { image: T },
  sourceAsset?: Asset,
): {
  image: T;
  isDuplicateUpload: boolean;
  originalDevicePhotoUri?: string;
} {
  const deviceUri = getGalleryAssetDevicePhotoUri( sourceAsset ?? photo.image );
  return {
    image: photo.image,
    isDuplicateUpload: !!( deviceUri && previouslyUploadedUris.has( deviceUri ) ),
    originalDevicePhotoUri: deviceUri ?? undefined,
  };
}

// Generic over the image so callers keep whatever they carry alongside the
// picker's own fields (e.g. the device asset's location) rather than having it
// typed away here.
export const markDuplicatePhotosFromLibrary = <T extends Asset>(
  realm: Realm,
  movedPhotos: { image: T }[],
  sourceAssets: Asset[] = [],
): {
  image: T;
  isDuplicateUpload: boolean;
  originalDevicePhotoUri?: string;
}[] => {
  const previouslyUploadedUris = getPreviouslyUploadedDevicePhotoUrisSet( realm );

  return movedPhotos.map( ( photo, index ) => markDuplicatePhotoFromLibrary(
    previouslyUploadedUris,
    photo,
    sourceAssets[index],
  ) );
};
