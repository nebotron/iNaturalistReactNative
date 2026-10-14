import { useCallback, useEffect, useState } from "react";
import { Image } from "react-native";

import { getAnimalCrop, subscribeAnimalCropLog } from "./animalCropLog";
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

export interface SubjectDetectionOptions {
  // Only honor a crop the user framed by hand (a crop log entry); never run the
  // AI subject detector. This is how the user's own photos work: they're shown
  // full-frame unless the user has framed them themselves.
  loggedCropOnly?: boolean;
}

const getCachedResult = ( uri: string ): DetectionResult | null => {
  const loggedCrop = getAnimalCrop( uri );
  const existing = cache.get( uri );
  if ( loggedCrop && existing ) return { ...existing, crop: loggedCrop };
  return existing ?? null;
};

// Same lookup, but a cached AI detection doesn't count: only a crop the user
// framed by hand does.
const getLoggedResult = ( uri: string ): DetectionResult | null => {
  const loggedCrop = getAnimalCrop( uri );
  if ( !loggedCrop ) return null;
  const existing = cache.get( uri );
  return existing
    ? { ...existing, crop: loggedCrop }
    : null;
};

const readResult = (
  uri: string,
  loggedCropOnly: boolean,
): DetectionResult | null => ( loggedCropOnly
  ? getLoggedResult( uri )
  : getCachedResult( uri ) );

// Resolves the best crop for a URI (crop log entry wins over AI detection),
// reusing the module cache and de-duplicating concurrent runs so the detector
// only executes once per URI. Awaiting this is how a caller "waits for the
// subject detector to be ready".
export const resolveSubjectDetectionForUri = async (
  uri: string,
  { loggedCropOnly = false }: SubjectDetectionOptions = {},
): Promise<DetectionResult | null> => {
  const cached = readResult( uri, loggedCropOnly );
  if ( cached ) return cached;
  if ( loggedCropOnly && !getAnimalCrop( uri ) ) return null;

  // Logged-crop-only runs never reach the detector, so they can't share an
  // in-flight full detection.
  const inflightKey = loggedCropOnly
    ? `loggedCropOnly:${uri}`
    : uri;
  const existing = inflight.get( inflightKey );
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
    if ( loggedCropOnly ) return null;
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

  inflight.set( inflightKey, promise );
  try {
    return await promise;
  } finally {
    inflight.delete( inflightKey );
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

const useSubjectDetectionForUri = (
  uri?: string,
  { loggedCropOnly = false }: SubjectDetectionOptions = {},
): DetectionResult | null => {
  const read = useCallback( ( ): DetectionResult | null => (
    uri
      ? readResult( uri, loggedCropOnly )
      : null
  ), [loggedCropOnly, uri] );

  const stateKey = `${loggedCropOnly}:${uri ?? ""}`;
  const [prevStateKey, setPrevStateKey] = useState( stateKey );
  const [result, setResult] = useState<DetectionResult | null>( read );

  // Synchronously reset state when the URI changes so the first render with the
  // new URI never shows a stale crop from the previous one.
  if ( prevStateKey !== stateKey ) {
    setPrevStateKey( stateKey );
    setResult( read( ) );
  }

  useEffect( ( ) => {
    if ( !uri ) {
      return ( ) => {};
    }

    let cancelled = false;
    resolveSubjectDetectionForUri( uri, { loggedCropOnly } )
      .then( detection => {
        if ( cancelled || !detection ) return;
        setResult( detection );
      } )
      .catch( ( ) => {
        // Detection failed, leave result as-is (image shows with default cover)
      } );

    // Framing this photo by hand on another screen (pinching in the media
    // viewer, saving in the crop editor) should show up here too, so follow the
    // crop log rather than only reading it once. Resolving again rather than
    // reading the cache covers the first framing of a photo, where the image
    // dimensions the crop is drawn against haven't been looked up yet.
    const unsubscribe = subscribeAnimalCropLog( ( ) => {
      resolveSubjectDetectionForUri( uri, { loggedCropOnly } )
        .then( detection => {
          if ( cancelled ) return;
          // Null here means the framing was removed, so drop it.
          setResult( detection );
        } )
        .catch( ( ) => {
          // Leave the framing as-is if the new crop can't be resolved.
        } );
    } );

    return ( ) => {
      cancelled = true;
      unsubscribe( );
    };
  }, [loggedCropOnly, uri] );

  return result;
};

export default useSubjectDetectionForUri;
