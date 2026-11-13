import findGroupedPhotoByDisplayUri
  from "components/SharedComponents/ImageCrop/findGroupedPhotoByDisplayUri";
import { saveAnimalCrop } from "sharedHelpers/animalCropLog";
import { getBrightness, saveBrightness } from "sharedHelpers/brightnessLog";
import cropImageFile from "sharedHelpers/cropImageFile";
import { cropOriginalUriFromPath, preserveCropOriginalPath } from "sharedHelpers/cropPhotoMetadata";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import imageFileSize from "sharedHelpers/imageFileSize";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { isSameCrop } from "sharedHelpers/normalizedCropTypes";
import { trackGroupPhotoCrop } from "sharedHelpers/pendingGroupPhotoCrops";
import { recordStagedImportCrop } from "sharedHelpers/usbStaging";
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
  brightness = 1,
): Promise<Partial<GroupedPhotoImage>> {
  const croppedUri = await cropImageFile( sourceUri, crop, size.w, size.h, undefined, brightness );
  const cropOriginalPath = await preserveCropOriginalPath( sourceUri, existingCropOriginalUri );
  const cropOriginalUri = cropOriginalUriFromPath( cropOriginalPath ) || sourceUri;
  saveAnimalCrop( displayUri, crop );
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
  brightness = 1,
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
    brightness,
  );
  if ( existingPhoto?.originalDevicePhotoUri ) {
    recordStagedImportCrop( existingPhoto.originalDevicePhotoUri, crop );
  }
  if ( update.uri ) {
    // The slider reads brightness by uri, so a re-crop of the cropped file
    // starts from the brightness just baked in.
    if ( brightness !== 1 ) await saveBrightness( update.uri, brightness );
    onCropped?.( update.uri );
  }
  updateGroupedPhotoImages( new Map( [[displayUri, update]] ) );
}

// Pinching a photo in the Group Photos grid crops it the same way the crop
// editor does. Each crop replaces the photo's uri with the cropped file's, so
// a later pinch on the same cell (which still knows the photo by its old uri)
// follows these renames to find it in the store.
const renamedDisplayUris = new Map<string, string>( );
// Pinch crops run one at a time, so a second pinch on a photo whose first crop
// is still being written waits for that crop's rename to land.
let pinchCropQueue: Promise<void> = Promise.resolve( );

const resolveDisplayUri = ( uri: string ): string => {
  let current = uri;
  const seen = new Set<string>( );
  while ( renamedDisplayUris.has( current ) && !seen.has( current ) ) {
    seen.add( current );
    current = renamedDisplayUris.get( current ) as string;
  }
  return current;
};

const isWholeFrame = ( crop: NormalizedCrop ) => isSameCrop( crop, {
  x: 0, y: 0, w: 1, h: 1,
} );

// The crop is relative to the photo's untouched original (cropOriginalUri, or
// the photo itself before its first crop), which is what the grid draws while
// the user pinches it.
export function applyGroupPhotosPinchCrop(
  displayUri: string,
  crop: NormalizedCrop,
): void {
  const job = pinchCropQueue.then( async ( ) => {
    const currentUri = resolveDisplayUri( displayUri );
    const photo = findGroupedPhotoByDisplayUri(
      useStore.getState( ).groupedPhotos,
      currentUri,
    );
    if ( !photo ) return;
    const existingCrop = photo.image.crop;
    // Nothing to write when the framing didn't change, or when an uncropped
    // photo was pinched back out to show all of it.
    if ( existingCrop
      ? isSameCrop( existingCrop, crop )
      : isWholeFrame( crop ) ) {
      return;
    }
    const sourceUri = await ensureLocalImageForCrop(
      photo.image.cropOriginalUri || currentUri,
      "original",
    );
    const size = await imageFileSize( sourceUri );
    if ( !size ) return;
    await applyGroupPhotosCrop(
      crop,
      currentUri,
      sourceUri,
      size,
      croppedUri => {
        renamedDisplayUris.set( currentUri, croppedUri );
      },
      // Keep any brightness set in the crop editor, which is baked into the
      // cropped file rather than the original
      getBrightness( currentUri ) ?? 1,
    );
  } );
  pinchCropQueue = job.catch( ( ) => undefined );
  // Importing waits on this like any other crop
  trackGroupPhotoCrop( job );
}
