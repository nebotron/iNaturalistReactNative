import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";

type PhotoNode = PhotoIdentifier["node"];

const SECTION_GAP_SECONDS = 5 * 60;

export interface PhotoSectionHeaderItem {
  type: "header";
  id: string;
  timestamp: number;
}

export interface PhotoSectionPhotoItem {
  type: "photo";
  id: string;
  node: PhotoNode;
}

export type PhotoGalleryListItem = PhotoSectionHeaderItem | PhotoSectionPhotoItem;

// photos is assumed sorted newest-first, as returned by CameraRoll.getPhotos.
// Inserts a header before the first photo of each run whose gap to the
// previous (newer) photo exceeds SECTION_GAP_SECONDS.
const buildSectionedGalleryItems = (
  photos: PhotoNode[],
  getKey: ( node: PhotoNode ) => string,
): PhotoGalleryListItem[] => {
  const items: PhotoGalleryListItem[] = [];

  photos.forEach( ( node, index ) => {
    const previous = photos[index - 1];
    const isNewSection = index === 0
      || ( previous.timestamp - node.timestamp ) > SECTION_GAP_SECONDS;
    if ( isNewSection ) {
      items.push( {
        type: "header",
        id: `header-${node.timestamp}-${index}`,
        timestamp: node.timestamp,
      } );
    }
    items.push( {
      type: "photo",
      id: getKey( node ),
      node,
    } );
  } );

  return items;
};

export default buildSectionedGalleryItems;
