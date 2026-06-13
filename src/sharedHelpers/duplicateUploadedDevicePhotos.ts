import { Alert } from "react-native";
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

export const isPreviouslyUploadedDevicePhotoUri = (
  realm: Realm,
  devicePhotoUri: string | null | undefined,
  excludeObservationUuids: string[] = [],
): boolean => {
  const normalizedUri = normalizeDevicePhotoUri( devicePhotoUri );
  if ( !normalizedUri ) {
    return false;
  }
  return getPreviouslyUploadedDevicePhotoUrisSet( realm, excludeObservationUuids )
    .has( normalizedUri );
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

export const findDuplicateUploadedDevicePhotoUris = (
  realm: Realm,
  uuidsToUpload: string[],
): string[] => {
  const previouslyUploadedUris = getPreviouslyUploadedDevicePhotoUrisSet(
    realm,
    uuidsToUpload,
  );

  const duplicateUris = new Set<string>( );
  uuidsToUpload.forEach( uuid => {
    const observation = realm.objectForPrimaryKey<RealmObservation>( "Observation", uuid );
    if ( !observation ) {
      return;
    }
    getDevicePhotoUrisFromObservation( observation ).forEach( uri => {
      if ( previouslyUploadedUris.has( uri ) ) {
        duplicateUris.add( uri );
      }
    } );
  } );

  return [...duplicateUris];
};

export const confirmUploadDespiteDuplicatePhotos = (
  t: ( key: string ) => string,
): Promise<boolean> => new Promise( resolve => {
  Alert.alert(
    t( "Duplicate-photo-upload-title" ),
    t( "Duplicate-photo-upload-message" ),
    [
      {
        text: t( "Cancel" ),
        style: "cancel",
        onPress: () => resolve( false ),
      },
      {
        text: t( "Upload-anyway" ),
        onPress: () => resolve( true ),
      },
    ],
  );
} );

export const confirmNoDuplicatePhotosBeforeUpload = async (
  realm: Realm,
  uuidsToUpload: string[],
  t: ( key: string ) => string,
): Promise<boolean> => {
  const duplicateUris = findDuplicateUploadedDevicePhotoUris( realm, uuidsToUpload );
  if ( duplicateUris.length === 0 ) {
    return true;
  }
  return confirmUploadDespiteDuplicatePhotos( t );
};
