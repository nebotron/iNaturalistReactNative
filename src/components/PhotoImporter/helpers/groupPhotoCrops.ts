import findGroupedPhotoByDisplayUri
  from "components/SharedComponents/ImageCrop/findGroupedPhotoByDisplayUri";
import { saveAnimalCrop } from "sharedHelpers/animalCropLog";
import { recordCropFeedback } from "sharedHelpers/cropFeedbackLog";
import cropImageFile from "sharedHelpers/cropImageFile";
import { cropOriginalUriFromPath, preserveCropOriginalPath } from "sharedHelpers/cropPhotoMetadata";
import { preloadImage } from "sharedHelpers/imageCropPreload";
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

// A crop that hasn't been written to a file yet: pinching a photo in the Group
// Photos grid records the crop only (see saveGroupPhotoCrop), so panning around
// the grid never writes a full-resolution file per gesture.
const hasUnbakedCrop = ( image: GroupedPhotoImage ) => Boolean(
  image.crop && !image.cropOriginalUri,
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

// Records a crop the user framed by pinching a photo in the Group Photos grid.
// The cropped file is written later (bakePendingGroupPhotoCrops, on import) so
// a gesture costs nothing but a store write, and the crop log entry keeps the
// framing if the cell is recycled before then.
export function saveGroupPhotoCrop( displayUri: string, crop: NormalizedCrop ): void {
  saveAnimalCrop( displayUri, crop );
  updateGroupedPhotoImages( new Map( [[displayUri, { crop }]] ) );
}

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
  return { uri: croppedUri, cropOriginalUri, crop };
}

// Everything here reads the store fresh rather than from the caller's closure:
// in a bulk crop this runs after the user has already advanced past this photo,
// by which point later crops (or a deletion) may have replaced groupedPhotos.
export async function applyGroupPhotosCrop(
  crop: NormalizedCrop,
  displayUri: string,
  sourceUri: string,
  size: { w: number; h: number },
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
  updateGroupedPhotoImages( new Map( [[displayUri, update]] ) );
}

// How many crops to write at once. Each one decodes and re-encodes a
// full-resolution photo, so the whole set can't run in parallel.
const BAKE_BATCH_SIZE = 4;

// Writes the cropped files for every photo cropped by pinching it in the grid.
// Called just before the grouped photos are imported as observations, which is
// the first time the cropped files are actually needed.
export async function bakePendingGroupPhotoCrops( ): Promise<void> {
  const pending: GroupedPhotoImage[] = [];
  useStore.getState( ).groupedPhotos.forEach( ( group: GroupedPhotoGroup ) => {
    group.photos?.forEach( photo => {
      if ( hasUnbakedCrop( photo.image ) ) {
        pending.push( photo.image );
      }
    } );
  } );
  if ( pending.length === 0 ) {
    return;
  }

  const updates = new Map<string, Partial<GroupedPhotoImage>>( );
  const bake = async ( image: GroupedPhotoImage ) => {
    try {
      // Passing the crop skips subject detection; this only resolves the local
      // file and its dimensions, and usually hits the cache the grid warmed.
      const loaded = await preloadImage( image.uri, image.uri, image.crop! );
      if ( !loaded ) {
        return;
      }
      updates.set( image.uri, await cropGroupPhotoFile(
        image.crop!,
        image.uri,
        loaded.localUri,
        loaded.size,
      ) );
    } catch {
      // Leave the photo uncropped rather than failing the whole import.
    }
  };

  for ( let i = 0; i < pending.length; i += BAKE_BATCH_SIZE ) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all( pending.slice( i, i + BAKE_BATCH_SIZE ).map( bake ) );
  }

  if ( updates.size > 0 ) {
    updateGroupedPhotoImages( updates );
  }
}
