import findGroupedPhotoByDisplayUri
  from "components/SharedComponents/ImageCrop/findGroupedPhotoByDisplayUri";
import { saveAnimalCrop } from "sharedHelpers/animalCropLog";
import { recordCropFeedback } from "sharedHelpers/cropFeedbackLog";
import cropImageFile from "sharedHelpers/cropImageFile";
import { cropOriginalUriFromPath, preserveCropOriginalPath } from "sharedHelpers/cropPhotoMetadata";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import useStore from "stores/useStore";

export interface GroupedPhotoImage {
  uri: string;
  cropOriginalUri?: string;
  crop?: NormalizedCrop;
}

interface GroupedPhotoItem {
  image: GroupedPhotoImage;
}

interface GroupedPhotoGroup {
  photos?: GroupedPhotoItem[];
}

// The uncropped original a photo's crop is expressed against. Once a crop has
// been baked into a file, image.uri points at the cropped file and the
// untouched original lives at cropOriginalUri.
export const groupPhotoCropSourceUri = ( image: GroupedPhotoImage ): string => (
  image.cropOriginalUri || image.uri
);

const updateGroupedPhotoImages = (
  updates: Map<string, Partial<GroupedPhotoImage>>,
) => {
  const store = useStore.getState( );
  store.setGroupedPhotos( store.groupedPhotos.map( ( group: GroupedPhotoGroup ) => {
    if ( !group.photos?.some( photo => updates.has( photo.image.uri ) ) ) {
      return group;
    }
    return {
      ...group,
      photos: group.photos.map( photo => {
        const update = updates.get( photo.image.uri );
        return update
          ? { ...photo, image: { ...photo.image, ...update } }
          : photo;
      } ),
    };
  } ) );
};

// Writes the cropped file and stashes the untouched original for future
// re-crops, without touching the store.
async function cropGroupPhotoFile(
  crop: NormalizedCrop,
  displayUri: string,
  sourceUri: string,
  size: { w: number; h: number },
  existingCropOriginalUri?: string,
): Promise<Partial<GroupedPhotoImage>> {
  const croppedUri = await cropImageFile( sourceUri, crop, size.w, size.h );
  const cropOriginalPath = await preserveCropOriginalPath( sourceUri, existingCropOriginalUri );
  const cropOriginalUri = cropOriginalUriFromPath( cropOriginalPath ) || sourceUri;
  saveAnimalCrop( displayUri, crop );
  recordCropFeedback( cropOriginalUri, { crop, kept: true } );
  return {
    uri: croppedUri, cropOriginalUri, crop,
  };
}

// Everything here reads the store fresh rather than from the caller's closure:
// in a bulk crop this runs after the user has already advanced past this photo,
// by which point later crops (or a deletion) may have replaced groupedPhotos.
// onCropped is called with the cropped file's uri before the store is
// updated, so a caller tracking photos by uri (the bulk crop of an import,
// which takes its queue from the store) can account for the photo's new uri
// before it appears in the store under it.
export async function applyGroupPhotosCrop(
  crop: NormalizedCrop,
  displayUri: string,
  sourceUri: string,
  size: { w: number; h: number },
  onCropped?: ( croppedUri: string ) => void,
): Promise<void> {
  const existingPhoto = findGroupedPhotoByDisplayUri(
    useStore.getState( ).groupedPhotos,
    displayUri,
  );
  const update = await cropGroupPhotoFile(
    crop,
    displayUri,
    sourceUri,
    size,
    existingPhoto?.image.cropOriginalUri,
  );
  if ( update.uri ) {
    onCropped?.( update.uri );
  }
  updateGroupedPhotoImages( new Map( [[displayUri, update]] ) );
}
