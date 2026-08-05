import { useEffect, useState } from "react";
import { Image } from "react-native";

import { getAnimalCrop } from "./animalCropLog";
import detectSubjectInImage from "./detectSubjectInImage";
import type { NormalizedCrop } from "./normalizedCropTypes";

export interface ThumbnailDetection {
  // Null while a saved crop made detection unnecessary
  crop: NormalizedCrop | null;
  // Dimensions of the thumbnail, not the original. Every crop calculation is
  // in normalized coordinates and only ever uses these as an aspect ratio, so
  // the thumbnail's own size is as good as the original's.
  imageWidth: number;
  imageHeight: number;
}

const sizeCache = new Map<string, { w: number; h: number }>( );
const cropCache = new Map<string, NormalizedCrop>( );
const inflight = new Map<string, Promise<ThumbnailDetection | null>>( );

const getImageSize = (
  uri: string,
): Promise<{ w: number; h: number } | null> => new Promise( resolve => {
  Image.getSize(
    uri,
    ( w, h ) => resolve( { w, h } ),
    ( ) => resolve( null ),
  );
} );

// Detection is cheap per image but not free, and a screenful of cells asks for
// it at once. Cap how many run together so the ones on screen aren't waiting
// behind the whole grid.
const MAX_CONCURRENT = 3;
const queue: ( ( ) => void )[] = [];
let active = 0;

const runQueued = async <T>( task: ( ) => Promise<T> ): Promise<T> => {
  if ( active >= MAX_CONCURRENT ) {
    await new Promise<void>( resolve => {
      queue.push( resolve );
    } );
  }
  active += 1;
  try {
    return await task( );
  } finally {
    active -= 1;
    queue.shift( )?.( );
  }
};

// The crop already detected for a photo, if any. Lets the full-resolution
// pipeline (the crop editor) skip a second detection run for a photo the grid
// has already framed.
export const getThumbnailDetectedCrop = (
  cropSourceUri: string,
): NormalizedCrop | null => cropCache.get( cropSourceUri ) ?? null;

const cachedDetection = (
  cropSourceUri: string,
  hasSavedCrop: boolean,
): ThumbnailDetection | null => {
  const size = sizeCache.get( cropSourceUri );
  if ( !size ) return null;
  const crop = hasSavedCrop
    ? null
    : cropCache.get( cropSourceUri ) ?? null;
  if ( !hasSavedCrop && !crop ) return null;
  return { crop, imageWidth: size.w, imageHeight: size.h };
};

// Subject detection for a photo, run against the small thumbnail a grid cell
// has already generated instead of the full-resolution original. The detector
// reports normalized coordinates and downscales its input to 1024px anyway, so
// a thumbnail yields the same crop — without waiting on the photo library to
// export a full-resolution file first, which is what made the crop take
// seconds to land on a screenful of cells.
export const resolveThumbnailSubjectDetection = (
  cropSourceUri: string,
  thumbnailUri: string,
  hasSavedCrop: boolean,
): Promise<ThumbnailDetection | null> => {
  const existing = inflight.get( cropSourceUri );
  if ( existing ) return existing;

  const promise = runQueued( async ( ): Promise<ThumbnailDetection | null> => {
    const size = sizeCache.get( cropSourceUri ) ?? await getImageSize( thumbnailUri );
    if ( !size ) return null;
    sizeCache.set( cropSourceUri, size );
    let crop = cropCache.get( cropSourceUri ) ?? null;
    if ( !crop && !hasSavedCrop ) {
      const loggedCrop = getAnimalCrop( cropSourceUri );
      crop = loggedCrop ?? await detectSubjectInImage( thumbnailUri, size.w, size.h );
      cropCache.set( cropSourceUri, crop );
    }
    return { crop, imageWidth: size.w, imageHeight: size.h };
  } ).catch( ( ) => null ).finally( ( ) => {
    inflight.delete( cropSourceUri );
  } );

  inflight.set( cropSourceUri, promise );
  return promise;
};

// Returns the thumbnail's dimensions and, unless the photo already has a saved
// crop, the crop its subject was detected at. Yields null until the thumbnail
// exists, since everything here is derived from it.
const useThumbnailSubjectDetection = (
  cropSourceUri: string,
  thumbnailUri: string | undefined,
  hasSavedCrop: boolean,
): ThumbnailDetection | null => {
  const [prevUri, setPrevUri] = useState( cropSourceUri );
  const [detection, setDetection] = useState<ThumbnailDetection | null>(
    ( ) => cachedDetection( cropSourceUri, hasSavedCrop ),
  );

  // Synchronously drop the previous photo's detection when a recycled cell
  // lands on a different one, so it is never framed with the wrong crop.
  if ( prevUri !== cropSourceUri ) {
    setPrevUri( cropSourceUri );
    setDetection( cachedDetection( cropSourceUri, hasSavedCrop ) );
  }

  useEffect( ( ) => {
    if ( !thumbnailUri ) return ( ) => {};
    let cancelled = false;
    resolveThumbnailSubjectDetection( cropSourceUri, thumbnailUri, hasSavedCrop )
      .then( result => {
        if ( !cancelled && result ) setDetection( result );
      } );
    return ( ) => {
      cancelled = true;
    };
  }, [cropSourceUri, hasSavedCrop, thumbnailUri] );

  return detection;
};

export default useThumbnailSubjectDetection;
