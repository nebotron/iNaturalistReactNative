import type { Asset } from "react-native-image-picker";
import type Realm from "realm";
import type { RealmObservation } from "realmModels/types";
import UploadedDevicePhotoUri from "realmModels/UploadedDevicePhotoUri";
import {
  getGalleryAssetDevicePhotoUri,
  normalizeDevicePhotoUri,
} from "sharedHelpers/getOriginalDevicePhotoUri";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";

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
  const normalizedUris = devicePhotoUris
    .map( normalizeDevicePhotoUri )
    .filter( ( uri ): uri is string => !!uri );

  if ( normalizedUris.length === 0 ) {
    return;
  }

  safeRealmWrite( realm, ( ) => {
    normalizedUris.forEach( uri => {
      realm.create(
        UploadedDevicePhotoUri.schema.name,
        { uri, uploadedAt: new Date( ) },
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

export const getPreviouslyUploadedDevicePhotoUrisSet = (
  realm: Realm,
  excludeObservationUuids: string[] = [],
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
