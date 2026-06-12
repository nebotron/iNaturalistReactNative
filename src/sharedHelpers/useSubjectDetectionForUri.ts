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

const useSubjectDetectionForUri = ( uri?: string ): DetectionResult | null => {
  const [result, setResult] = useState<DetectionResult | null>( ( ) => {
    if ( !uri ) return null;
    const loggedCrop = getAnimalCrop( uri );
    const existing = cache.get( uri );
    if ( loggedCrop && existing ) return { ...existing, crop: loggedCrop };
    return existing ?? null;
  } );

  useEffect( ( ) => {
    if ( !uri ) {
      setResult( null );
      return ( ) => {};
    }

    // Ground-truth crop log entries always win over the AI-detection cache.
    const loggedCrop = getAnimalCrop( uri );
    const existing = cache.get( uri );

    if ( !loggedCrop && existing ) {
      setResult( existing );
      return ( ) => {};
    }

    if ( loggedCrop && existing ) {
      const updated = { ...existing, crop: loggedCrop };
      cache.set( uri, updated );
      setResult( updated );
      return ( ) => {};
    }

    let cancelled = false;

    ( async ( ) => {
      try {
        if ( loggedCrop ) {
          // Fast path: crop log entry exists — only need image dimensions.
          // Use Image.getSize on the large URL directly; no local file download
          // or AI detection needed.
          const imageSize = await getImageSize( toLargeUri( uri ) );
          if ( cancelled || !imageSize ) return;

          const detection: DetectionResult = {
            crop: loggedCrop,
            imageWidth: imageSize.w,
            imageHeight: imageSize.h,
          };
          cache.set( uri, detection );
          setResult( detection );
        } else {
          // Slow path: no crop log entry — download to a local file and run
          // the AI subject detector.
          const localUri = await ensureLocalImageForCrop( uri );
          if ( cancelled ) return;

          const imageSize = await getImageSize( localUri );
          if ( cancelled || !imageSize ) return;

          const crop = await detectSubjectInImage( localUri, imageSize.w, imageSize.h );
          if ( cancelled ) return;

          const detection: DetectionResult = {
            crop,
            imageWidth: imageSize.w,
            imageHeight: imageSize.h,
          };
          cache.set( uri, detection );
          setResult( detection );
        }
      } catch {
        // Detection failed, leave result as null (image shows with default cover)
      }
    } )( );

    return ( ) => {
      cancelled = true;
    };
  }, [uri] );

  return result;
};

export default useSubjectDetectionForUri;
