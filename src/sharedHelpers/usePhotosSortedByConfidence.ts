import { useEffect, useRef, useState } from "react";
import { NativeModules } from "react-native";

import ensureLocalImageForCrop, { stripFilePrefix } from "./ensureLocalImageForCrop";

interface ImageCropperModule {
  detectSubjectBounds: (
    inputPath: string,
    model: string,
  ) => Promise<{ confidence?: number } | null>;
}

const confidenceCache = new Map<string, number>( );

async function fetchConfidenceForUri( uri: string ): Promise<number> {
  if ( confidenceCache.has( uri ) ) {
    return confidenceCache.get( uri )!;
  }
  try {
    const localUri = await ensureLocalImageForCrop( uri );
    const imageCropper = (
      NativeModules as { ImageCropper?: ImageCropperModule }
    ).ImageCropper;
    if ( !imageCropper?.detectSubjectBounds ) {
      confidenceCache.set( uri, 0 );
      return 0;
    }
    const bounds = await imageCropper.detectSubjectBounds(
      stripFilePrefix( localUri ),
      "A",
    );
    const confidence = bounds?.confidence ?? 0;
    confidenceCache.set( uri, confidence );
    return confidence;
  } catch {
    confidenceCache.set( uri, 0 );
    return 0;
  }
}

// Returns photos sorted descending by subject-detector confidence when enabled.
// Initially returns photos in original order; updates asynchronously once
// detection completes for all photos.
const usePhotosSortedByConfidence = (
  photos: ( { uri: string } | null )[],
  enabled: boolean = true,
): ( { uri: string } | null )[] => {
  const [sortedPhotos, setSortedPhotos] = useState<( { uri: string } | null )[]>(
    photos,
  );

  const sortedPhotosRef = useRef( sortedPhotos );
  sortedPhotosRef.current = sortedPhotos;

  useEffect( ( ) => {
    setSortedPhotos( photos );

    if ( !enabled || photos.length <= 1 ) {
      return undefined;
    }

    let cancelled = false;

    ( async ( ) => {
      const results = await Promise.all(
        photos.map( async photo => ( {
          photo,
          confidence: photo?.uri
            ? await fetchConfidenceForUri( photo.uri )
            : 0,
        } ) ),
      );

      if ( cancelled ) return;

      const sorted = [...results]
        .sort( ( a, b ) => b.confidence - a.confidence )
        .map( r => r.photo );

      setSortedPhotos( sorted );
    } )( );

    return ( ) => { cancelled = true; };
  }, [enabled, photos] );

  return sortedPhotos;
};

export { fetchConfidenceForUri };
export default usePhotosSortedByConfidence;
