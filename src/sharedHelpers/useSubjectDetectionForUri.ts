import { useEffect, useState } from "react";
import { Image } from "react-native";

import { getAnimalCrop } from "./animalCropLog";
import ensureLocalImageForCrop from "./ensureLocalImageForCrop";
import getCropForUri from "./getCropForUri";
import type { NormalizedCrop } from "./normalizedCropTypes";

interface DetectionResult {
  crop: NormalizedCrop;
  imageWidth: number;
  imageHeight: number;
}

const cache = new Map<string, DetectionResult>( );

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

        const crop = await getCropForUri( uri, localUri, imageSize.w, imageSize.h );
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
