import type { Asset } from "react-native-image-picker";
import Photo from "realmModels/Photo";
import type { RealmObservationPhoto } from "realmModels/types";
import {
  getGalleryAssetDevicePhotoUri,
  lookupImportedPhotoDeviceUri,
  normalizeDevicePhotoUri,
} from "sharedHelpers/getOriginalDevicePhotoUri";
import useStore from "stores/useStore";

export interface GroupedPhotoWithDeviceUri {
  image: Asset;
  originalDevicePhotoUri?: string | null;
}

const resolveFromImportedMappings = (
  mappings: Record<string, string>,
  localUris: ( string | null | undefined )[],
): string | null => {
  for ( const localUri of localUris ) {
    const mappedUri = lookupImportedPhotoDeviceUri( mappings, localUri );
    if ( mappedUri ) {
      return mappedUri;
    }
  }
  return null;
};

export const resolveDevicePhotoUriFromGroupedPhoto = (
  photo: GroupedPhotoWithDeviceUri,
  importedPhotoDeviceUriByLocalUri?: Record<string, string>,
): string | null => {
  const mappings = importedPhotoDeviceUriByLocalUri
    ?? useStore.getState( ).importedPhotoDeviceUriByLocalUri;
  const explicitUri = normalizeDevicePhotoUri( photo.originalDevicePhotoUri );
  if ( explicitUri ) {
    return explicitUri;
  }
  const fromAsset = normalizeDevicePhotoUri( getGalleryAssetDevicePhotoUri( photo.image ) );
  if ( fromAsset ) {
    return fromAsset;
  }
  return resolveFromImportedMappings(
    mappings,
    [photo.image.uri],
  );
};

export const resolveDevicePhotoUriForRemovedObservationPhoto = (
  removedPhoto: Pick<
    RealmObservationPhoto,
    "originalDevicePhotoUri" | "originalPhotoUri" | "photo"
  >,
  observationPhotos: Pick<
    RealmObservationPhoto,
    "originalDevicePhotoUri" | "originalPhotoUri" | "photo"
  >[],
  removedPhotoIndex: number,
  cameraRollUris: string[],
  importedPhotoDeviceUriByLocalUri: Record<string, string> = {},
): string | null => {
  const fromField = normalizeDevicePhotoUri( removedPhoto.originalDevicePhotoUri );
  if ( fromField ) {
    return fromField;
  }

  const fromMappings = resolveFromImportedMappings(
    importedPhotoDeviceUriByLocalUri,
    [
      removedPhoto.originalPhotoUri,
      removedPhoto.photo?.localFilePath,
      Photo.getLocalPhotoUri( removedPhoto.photo?.localFilePath ),
      removedPhoto.photo?.url,
    ],
  );
  if ( fromMappings ) {
    return fromMappings;
  }

  const localOnlyIndices = observationPhotos
    .map( ( obsPhoto, index ) => {
      const hasDeviceUri = !!(
        normalizeDevicePhotoUri( obsPhoto.originalDevicePhotoUri )
        || resolveFromImportedMappings(
          importedPhotoDeviceUriByLocalUri,
          [
            obsPhoto.originalPhotoUri,
            obsPhoto.photo?.localFilePath,
            Photo.getLocalPhotoUri( obsPhoto.photo?.localFilePath ),
          ],
        )
      );
      return hasDeviceUri
        ? null
        : index;
    } )
    .filter( ( index ): index is number => index !== null );

  const localOnlyIndex = localOnlyIndices.indexOf( removedPhotoIndex );
  if ( localOnlyIndex >= 0 && localOnlyIndex < cameraRollUris.length ) {
    return normalizeDevicePhotoUri( cameraRollUris[localOnlyIndex] );
  }

  return null;
};

export const deleteDevicePhotosRemovedDuringObservationPrep = (
  photoUris: ( string | null | undefined )[],
): void => {
  const uniqueUris = [...new Set(
    photoUris
      .map( uri => normalizeDevicePhotoUri( uri ) )
      .filter( ( uri ): uri is string => !!uri ),
  )];
  if ( uniqueUris.length === 0 ) {
    return;
  }

  // Require at call time so tests can mock deletion
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const promptDeleteOriginalDevicePhotos = require(
    "sharedHelpers/promptDeleteOriginalDevicePhotos",
  ).default;
  promptDeleteOriginalDevicePhotos( uniqueUris, ( ) => { } );
};
