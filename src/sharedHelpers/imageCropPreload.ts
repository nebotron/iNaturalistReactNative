import { Image as RNImage } from "react-native";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import getCropForUri from "sharedHelpers/getCropForUri";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";

export type PreloadResult = {
  localUri: string;
  size: { w: number; h: number };
  crop: NormalizedCrop;
};

// Module-level cache so preloaded data survives navigation.replace cycles
export const preloadCache = new Map<string, PreloadResult>( );
export const preloadInFlight = new Set<string>( );

export async function loadImageData(
  imageUri: string,
  cropSourceUri: string,
  existingSavedCrop: NormalizedCrop | null,
): Promise<PreloadResult | null> {
  const resolvedUri = await ensureLocalImageForCrop( cropSourceUri );
  const size = await new Promise<{ w: number; h: number } | null>( resolve => {
    RNImage.getSize(
      resolvedUri,
      ( w, h ) => resolve( { w, h } ),
      ( ) => resolve( null ),
    );
  } );
  if ( !size ) {
    return null;
  }
  const crop = existingSavedCrop
    ?? await getCropForUri( imageUri, resolvedUri, size.w, size.h );
  return { localUri: resolvedUri, size, crop };
}

export function preloadImage(
  imageUri: string,
  cropSourceUri: string,
  existingSavedCrop: NormalizedCrop | null,
) {
  if ( preloadCache.has( imageUri ) || preloadInFlight.has( imageUri ) ) {
    return;
  }
  preloadInFlight.add( imageUri );
  loadImageData( imageUri, cropSourceUri, existingSavedCrop )
    .then( result => {
      if ( result ) {
        preloadCache.set( imageUri, result );
      }
    } )
    .catch( ( ) => {} )
    .finally( ( ) => {
      preloadInFlight.delete( imageUri );
    } );
}
