import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";

interface GroupedPhotoItem {
  image: {
    uri: string;
    cropOriginalUri?: string;
    crop?: NormalizedCrop;
  };
}

interface GroupedPhotoGroup {
  photos?: GroupedPhotoItem[];
  videos?: { uri: string }[];
}

export function findGroupedPhotoByDisplayUri(
  groupedPhotos: GroupedPhotoGroup[],
  displayUri: string,
): GroupedPhotoItem | null {
  for ( const group of groupedPhotos ) {
    const match = group.photos?.find( photo => photo.image.uri === displayUri );
    if ( match ) {
      return match;
    }
  }
  return null;
}

export default findGroupedPhotoByDisplayUri;
