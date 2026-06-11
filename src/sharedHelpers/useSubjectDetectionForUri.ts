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

const useSubjectDetectionForUri = ( uri?: string ): DetectionResult | null => {
  const [result, setResult] = useState<DetectionResult | null>(
    uri
      ? cache.get( uri ) ?? null
      : null,
  );

  useEffect( ( ) => {
    if ( !uri ) {
      setResult( null );
      return ( ) => {};
    }

    const existing = cache.get( uri );
    if ( existing ) {
      setResult( existing );
      return ( ) => {};
    }

    let cancelled = false;

    ( async ( ) => {
      try {
        const localUri = await ensureLocalImageForCrop( uri );
        if ( cancelled ) return;

        const imageSize = await new Promise<{ w: number; h: number } | null>( resolve => {
          Image.getSize(
            localUri,
            ( w, h ) => resolve( { w, h } ),
            ( ) => resolve( null ),
          );
        } );
        if ( cancelled || !imageSize ) return;

        const loggedCrop = getAnimalCrop( uri );
        const crop = loggedCrop
          ?? await detectSubjectInImage( localUri, imageSize.w, imageSize.h );
        if ( cancelled ) return;

        const detection: DetectionResult = {
          crop,
          imageWidth: imageSize.w,
          imageHeight: imageSize.h,
        };
        cache.set( uri, detection );
        setResult( detection );
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
