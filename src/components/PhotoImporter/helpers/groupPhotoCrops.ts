import findGroupedPhotoByDisplayUri
  from "components/SharedComponents/ImageCrop/findGroupedPhotoByDisplayUri";
import { saveAnimalCrop } from "sharedHelpers/animalCropLog";
import { recordCropFeedback } from "sharedHelpers/cropFeedbackLog";
import cropImageFile from "sharedHelpers/cropImageFile";
import { cropOriginalUriFromPath, preserveCropOriginalPath } from "sharedHelpers/cropPhotoMetadata";
import { preloadImage } from "sharedHelpers/imageCropPreload";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { getThumbnailDetectedCrop } from "sharedHelpers/useThumbnailSubjectDetection";
import useStore from "stores/useStore";

const logger = log.extend( "groupPhotoCrops" );

export interface GroupedPhotoImage {
  uri: string;
  cropOriginalUri?: string;
  crop?: NormalizedCrop;
  // The crop the file at uri actually holds. Anything else in crop is still
  // only a framing, whether or not the photo was ever cropped before.
  bakedCrop?: NormalizedCrop;
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

// Crops round-trip through a screen-space transform, so re-reading the same
// framing can come back differing in the last few decimals.
const CROP_EPSILON = 0.001;

const cropsMatch = ( a?: NormalizedCrop, b?: NormalizedCrop ) => {
  if ( !a || !b ) {
    return false;
  }
  return Math.abs( a.x - b.x ) < CROP_EPSILON
    && Math.abs( a.y - b.y ) < CROP_EPSILON
    && Math.abs( a.w - b.w ) < CROP_EPSILON
    && Math.abs( a.h - b.h ) < CROP_EPSILON;
};

// The crop the Group Photos grid is showing this photo at: the one the user
// pinched, or else the one the detector framed the cell at. Every cell is drawn
// cropped to its crop box, so both are equally "the photo's crop" as far as the
// screen the user imports from is concerned.
const displayedCrop = ( image: GroupedPhotoImage ): NormalizedCrop | null => (
  image.crop ?? getThumbnailDetectedCrop( groupPhotoCropSourceUri( image ) )
);

// The crop a photo needs written to a file before it's imported, or null when
// its file already holds what the grid was showing. Pinching a photo records
// the crop only (see saveGroupPhotoCrop), so panning around the grid never
// writes a full-resolution file per gesture; comparing against the crop that
// was baked (rather than just asking whether the photo has ever been cropped)
// is also what keeps a re-pinch of an already-cropped photo from importing the
// older crop's file.
const unbakedCrop = ( image: GroupedPhotoImage ): NormalizedCrop | null => {
  const crop = displayedCrop( image );
  return crop && !cropsMatch( crop, image.bakedCrop )
    ? crop
    : null;
};

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
  return {
    uri: croppedUri, cropOriginalUri, crop, bakedCrop: crop,
  };
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

// Writes the cropped file for every photo the Group Photos grid was showing
// cropped — whether the user framed it by pinching or the detector framed it —
// so an imported observation holds the photo as the grid drew it. Called just
// before the grouped photos are imported as observations, which is the first
// time the cropped files are actually needed.
export async function bakePendingGroupPhotoCrops( ): Promise<void> {
  const pending: { image: GroupedPhotoImage; crop: NormalizedCrop }[] = [];
  useStore.getState( ).groupedPhotos.forEach( ( group: GroupedPhotoGroup ) => {
    group.photos?.forEach( photo => {
      const crop = unbakedCrop( photo.image );
      if ( crop ) {
        pending.push( { image: photo.image, crop } );
      }
    } );
  } );
  if ( pending.length === 0 ) {
    return;
  }

  const updates = new Map<string, Partial<GroupedPhotoImage>>( );
  const bake = async ( { image, crop }: { image: GroupedPhotoImage; crop: NormalizedCrop } ) => {
    try {
      // The crop is expressed against the uncropped original, which for a photo
      // that has already been cropped once is not image.uri.
      const sourceUri = groupPhotoCropSourceUri( image );
      // Passing the crop skips subject detection; this only resolves the
      // full-resolution local file and its dimensions, which is work the grid
      // deliberately never does (it crops thumbnails) and the cropper only
      // does for photos the user opened.
      const loaded = await preloadImage( sourceUri, sourceUri, crop );
      if ( !loaded ) {
        logger.warn( "Could not load a group photo to crop; importing it uncropped" );
        return;
      }
      updates.set( image.uri, await cropGroupPhotoFile(
        crop,
        image.uri,
        loaded.localUri,
        loaded.size,
        image.cropOriginalUri,
      ) );
    } catch ( error ) {
      // Leave the photo uncropped rather than failing the whole import, but say
      // so: a silently skipped crop is indistinguishable from one never framed.
      logger.error( "Failed to crop a group photo; importing it uncropped", error );
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
