import { useEffect, useState } from "react";
import { Image } from "react-native";

import { getAnimalCrop } from "./animalCropLog";
import detectSubjectInImage from "./detectSubjectInImage";
import ensureLocalImageForCrop from "./ensureLocalImageForCrop";
import type { NormalizedCrop } from "./normalizedCropTypes";

interface DetectionResult {
  crop: NormalizedCrop;
  imageWidth: number;
  imageHeight: number;
}

const cache = new Map<string, DetectionResult>( );
// In-flight detections, so concurrent callers for the same URI (e.g. the
// thumbnail and the computer vision request) share a single detector run
// instead of each kicking off their own.
const inflight = new Map<string, Promise<DetectionResult | null>>( );

const getImageSize = (
  uri: string,
): Promise<{ w: number; h: number } | null> => new Promise( resolve => {
  Image.getSize(
    uri,
    ( w, h ) => resolve( { w, h } ),
    ( ) => resolve( null ),
  );
} );

// Normalize a remote photo URL to the large size so Image.getSize downloads
// the smallest useful variant rather than square/medium/original.
const toLargeUri = ( uri: string ) => uri.replace(
  /(square|small|medium|original)/i,
  "large",
);

const getCachedResult = ( uri: string ): DetectionResult | null => {
  const loggedCrop = getAnimalCrop( uri );
  const existing = cache.get( uri );
  if ( loggedCrop && existing ) return { ...existing, crop: loggedCrop };
  return existing ?? null;
};

// Resolves the best crop for a URI (crop log entry wins over AI detection),
// reusing the module cache and de-duplicating concurrent runs so the detector
// only executes once per URI. Awaiting this is how a caller "waits for the
// subject detector to be ready".
export const resolveSubjectDetectionForUri = async (
  uri: string,
): Promise<DetectionResult | null> => {
  const cached = getCachedResult( uri );
  if ( cached ) return cached;

  const existing = inflight.get( uri );
  if ( existing ) return existing;

  const promise = ( async ( ): Promise<DetectionResult | null> => {
    const loggedCrop = getAnimalCrop( uri );
    if ( loggedCrop ) {
      // Fast path: crop log entry exists — only need image dimensions.
      const imageSize = await getImageSize( toLargeUri( uri ) );
      if ( !imageSize ) return null;
      const detection = {
        crop: loggedCrop,
        imageWidth: imageSize.w,
        imageHeight: imageSize.h,
      };
      cache.set( uri, detection );
      return detection;
    }
    // Slow path: download to a local file and run the AI subject detector.
    const localUri = await ensureLocalImageForCrop( uri );
    const imageSize = await getImageSize( localUri );
    if ( !imageSize ) return null;
    const crop = await detectSubjectInImage( localUri, imageSize.w, imageSize.h );
    const detection = {
      crop,
      imageWidth: imageSize.w,
      imageHeight: imageSize.h,
    };
    cache.set( uri, detection );
    return detection;
  } )( );

  inflight.set( uri, promise );
  try {
    return await promise;
  } finally {
    inflight.delete( uri );
  }
};

// Runs the full detection pipeline for a URI and populates the module cache so
// that when useSubjectDetectionForUri is later called with the same URI it can
// return synchronously without any async work.
export const preloadSubjectDetectionForUri = ( uri: string ): void => {
  if ( cache.has( uri ) ) return;
  resolveSubjectDetectionForUri( uri ).catch( ( ) => {
    // Best-effort preload; ignore failures.
  } );
};

const useSubjectDetectionForUri = ( uri?: string ): DetectionResult | null => {
  const [prevUri, setPrevUri] = useState<string | undefined>( uri );
  const [result, setResult] = useState<DetectionResult | null>( ( ) => (
    uri
      ? getCachedResult( uri )
      : null
  ) );

  // Synchronously reset state when the URI changes so the first render with the
  // new URI never shows a stale crop from the previous one.
  if ( prevUri !== uri ) {
    setPrevUri( uri );
    setResult(
      uri
        ? getCachedResult( uri )
        : null,
    );
  }

  useEffect( ( ) => {
    if ( !uri ) {
      return ( ) => {};
    }

    let cancelled = false;
    resolveSubjectDetectionForUri( uri )
      .then( detection => {
        if ( cancelled || !detection ) return;
        setResult( detection );
      } )
      .catch( ( ) => {
        // Detection failed, leave result as-is (image shows with default cover)
      } );

    return ( ) => {
      cancelled = true;
    };
  }, [uri] );

  return result;
};

export default useSubjectDetectionForUri;
