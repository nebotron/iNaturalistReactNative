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

export const markDuplicatePhotosFromLibrary = (
  realm: Realm,
  movedPhotos: { image: Asset }[],
  sourceAssets: Asset[] = [],
): { image: Asset; isDuplicateUpload: boolean }[] => {
  const previouslyUploadedUris = getPreviouslyUploadedDevicePhotoUrisSet( realm );

  return movedPhotos.map( ( { image }, index ) => {
    const sourceAsset = sourceAssets[index] ?? image;
    const deviceUri = getGalleryAssetDevicePhotoUri( sourceAsset );
    return {
      image,
      isDuplicateUpload: !!( deviceUri && previouslyUploadedUris.has( deviceUri ) ),
      originalDevicePhotoUri: deviceUri ?? undefined,
    };
  } );
};
