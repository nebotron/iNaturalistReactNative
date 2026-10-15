import type { SharedStackParamList } from "navigation/types";
import type { GroupCropResume, GroupedPhoto } from "stores/createObservationFlowSlice";

// Whether the cropper has anything to show for a grid cell. A GIF -- a video
// imported as one, or one picked from the library -- is never cropped, since
// that would write a single still frame back over the animation. A placeholder
// says so up front (PhotoLibrary's placeholderGroup); once its file has landed
// the name says it too.
export const isCroppable = ( photo: { croppable?: boolean; image: { uri: string } } ): boolean => (
  photo.croppable !== false && !photo.image.uri.toLowerCase( ).endsWith( ".gif" )
);

// The params that reopen the cropper where it was left, and the landed photos
// it still has to show, or null when there is nothing left of it to resume.
export const groupCropResumeParams = (
  resume: GroupCropResume | null,
  groupedPhotos: GroupedPhoto[],
): { params: SharedStackParamList["ImageCropEditor"]; remainingUris: string[] } | null => {
  if ( !resume ) return null;
  const photos = groupedPhotos.flatMap( group => group.photos ?? [] );
  if ( resume.cropImport ) {
    // A crop still being written when the cropper was left lands under a new
    // uri it never marked visited, but with its crop saved on it.
    const skip = new Set( resume.skipUris );
    const left = photos.filter( photo => isCroppable( photo )
      && !photo.image.crop
      && ( photo.image.uri === resume.imageUri || !skip.has( photo.image.uri ) ) );
    if ( !left.length ) return null;
    return {
      params: {
        context: "groupPhotos",
        cropImport: true,
        imageUri: resume.imageUri,
        skipUris: [
          ...resume.skipUris,
          ...photos.filter( photo => photo.image.crop ).map( photo => photo.image.uri ),
        ],
      },
      remainingUris: left.filter( photo => !photo.pending ).map( photo => photo.image.uri ),
    };
  }
  const landed = new Set( photos
    .filter( photo => !photo.pending )
    .map( photo => photo.image.uri ) );
  const [imageUri, ...pendingImageUris] = [
    ...( resume.imageUri
      ? [resume.imageUri]
      : [] ),
    ...resume.pendingImageUris,
  ].filter( uri => landed.has( uri ) );
  if ( !imageUri ) return null;
  return {
    params: {
      context: "groupPhotos",
      imageUri,
      pendingImageUris,
    },
    remainingUris: [imageUri, ...pendingImageUris],
  };
};
