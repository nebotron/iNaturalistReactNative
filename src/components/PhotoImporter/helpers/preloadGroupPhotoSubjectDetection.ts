import { prefetchDeviceImageThumbnail } from "sharedHelpers/useDeviceImageThumbnail";
import {
  hasThumbnailDetection,
  resolveThumbnailSubjectDetection,
} from "sharedHelpers/useThumbnailSubjectDetection";

import type { GroupedPhotoImage } from "./groupPhotoCrops";
import { groupPhotoCropSourceUri } from "./groupPhotoCrops";
import groupPhotoThumbnailMaxPixel from "./groupPhotoThumbnail";

interface GroupedPhotoItem {
  image: GroupedPhotoImage;
}

interface GroupedPhotoGroup {
  photos?: GroupedPhotoItem[];
}

// How many photos are warmed at once. Each one generates a thumbnail and then
// runs the detector on it, and both of those are capped again downstream; a
// small pool here is what keeps the preload from filling those queues with the
// whole import ahead of the cells the user is looking at.
const PRELOAD_CONCURRENCY = 3;

// Photos already walked, so a store change (a selection, a combine, a removal)
// restarts the walk without re-queueing the photos it already finished. Keyed
// by the uncropped original, same as the detection caches.
const walked = new Set<string>( );

// Runs subject detection for every photo in the import rather than only the
// cells the grid has mounted. A cell can't frame itself until its thumbnail
// exists and the detector has run on it, so a photo first reached by scrolling
// used to start that work only once it was already on screen — the crop landed
// seconds later, after the cell had been sitting there uncropped. Warming the
// whole set in the background means scrolling finds the crops already cached.
//
// Everything queued here is background priority: on-screen cells jump ahead in
// both the thumbnail queue and the detection queue, so preloading a large
// import never slows down the part of it the user can see.
//
// Returns a cancel function for when the screen goes away.
const preloadGroupPhotoSubjectDetection = (
  groups: GroupedPhotoGroup[],
  cellWidth: number,
): ( ( ) => void ) => {
  const maxPixel = groupPhotoThumbnailMaxPixel( cellWidth );
  const pending: { sourceUri: string; hasSavedCrop: boolean }[] = [];
  groups.forEach( group => {
    group.photos?.forEach( ( { image } ) => {
      const sourceUri = groupPhotoCropSourceUri( image );
      const hasSavedCrop = Boolean( image.crop );
      if ( walked.has( sourceUri ) || hasThumbnailDetection( sourceUri, hasSavedCrop ) ) {
        return;
      }
      pending.push( { sourceUri, hasSavedCrop } );
    } );
  } );

  let cancelled = false;
  let next = 0;

  const worker = async ( ) => {
    while ( !cancelled && next < pending.length ) {
      const { sourceUri, hasSavedCrop } = pending[next];
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      const thumbnailUri = await prefetchDeviceImageThumbnail( sourceUri, maxPixel );
      if ( cancelled ) return;
      if ( thumbnailUri ) {
        // eslint-disable-next-line no-await-in-loop
        await resolveThumbnailSubjectDetection( sourceUri, thumbnailUri, hasSavedCrop, true );
        walked.add( sourceUri );
      }
    }
  };

  for ( let i = 0; i < PRELOAD_CONCURRENCY; i += 1 ) {
    worker( );
  }

  return ( ) => {
    cancelled = true;
  };
};

export default preloadGroupPhotoSubjectDetection;
