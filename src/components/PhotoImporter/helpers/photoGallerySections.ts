import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";

type PhotoNode = PhotoIdentifier["node"];

const SECTION_GAP_SECONDS = 5 * 60;
const MAX_SECTION_SIZE = 100;

export interface PhotoSectionHeaderItem {
  type: "header";
  id: string;
  timestamp: number;
  nodes: PhotoNode[];
}

export interface PhotoSectionPhotoItem {
  type: "photo";
  id: string;
  node: PhotoNode;
}

export type PhotoGalleryListItem = PhotoSectionHeaderItem | PhotoSectionPhotoItem;

// nodes is assumed sorted newest-first. Splits on the largest time-gap
// between consecutive photos, recursively, until every chunk is no larger
// than MAX_SECTION_SIZE.
const splitOversizedSection = ( nodes: PhotoNode[] ): PhotoNode[][] => {
  if ( nodes.length <= MAX_SECTION_SIZE ) {
    return [nodes];
  }
  let splitIndex = 1;
  let maxGap = -Infinity;
  for ( let i = 1; i < nodes.length; i += 1 ) {
    const gap = nodes[i - 1].timestamp - nodes[i].timestamp;
    if ( gap > maxGap ) {
      maxGap = gap;
      splitIndex = i;
    }
  }
  return [
    ...splitOversizedSection( nodes.slice( 0, splitIndex ) ),
    ...splitOversizedSection( nodes.slice( splitIndex ) ),
  ];
};

// photos is assumed sorted newest-first, as returned by CameraRoll.getPhotos.
// Inserts a header before the first photo of each run whose gap to the
// previous (newer) photo exceeds SECTION_GAP_SECONDS. Sections larger than
// MAX_SECTION_SIZE are further split on their largest internal time-gaps.
// When morePhotosMayFollow is true, the trailing section is withheld: more
// photos could still be loaded that belong to it (or split it further), so
// it isn't finalized yet and shouldn't be shown.
const buildSectionedGalleryItems = (
  photos: PhotoNode[],
  getKey: ( node: PhotoNode ) => string,
  morePhotosMayFollow: boolean = false,
): PhotoGalleryListItem[] => {
  const items: PhotoGalleryListItem[] = [];
  let currentSection: PhotoNode[] = [];
  const sections: PhotoNode[][] = [];

  photos.forEach( ( node, index ) => {
    const previous = photos[index - 1];
    const isNewSection = index === 0
      || ( previous.timestamp - node.timestamp ) > SECTION_GAP_SECONDS;
    if ( isNewSection ) {
      currentSection = [];
      sections.push( currentSection );
    }
    currentSection.push( node );
  } );

  const finalizedSections = morePhotosMayFollow
    ? sections.slice( 0, -1 )
    : sections;

  finalizedSections
    .flatMap( splitOversizedSection )
    .forEach( ( nodes, index ) => {
      const [firstNode] = nodes;
      items.push( {
        type: "header",
        id: `header-${firstNode.timestamp}-${index}`,
        timestamp: firstNode.timestamp,
        nodes,
      } );
      nodes.forEach( node => {
        items.push( {
          type: "photo",
          id: getKey( node ),
          node,
        } );
      } );
    } );

  return items;
};

export default buildSectionedGalleryItems;
