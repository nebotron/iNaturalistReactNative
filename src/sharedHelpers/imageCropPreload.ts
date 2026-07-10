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
// Track in-flight loads by their promise so callers can await (and dedupe)
// an ongoing preload instead of kicking off duplicate, contending work.
export const preloadInFlight = new Map<string, Promise<PreloadResult | null>>( );

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

// Returns a promise resolving to the preload result. Reuses the module-level
// cache and dedupes concurrent loads for the same imageUri so the same
// expensive asset export + subject detection never runs twice at once.
export function preloadImage(
  imageUri: string,
  cropSourceUri: string,
  existingSavedCrop: NormalizedCrop | null,
): Promise<PreloadResult | null> {
  const cached = preloadCache.get( imageUri );
  if ( cached ) {
    return Promise.resolve( cached );
  }
  const inFlight = preloadInFlight.get( imageUri );
  if ( inFlight ) {
    return inFlight;
  }
  const promise = loadImageData( imageUri, cropSourceUri, existingSavedCrop )
    .then( result => {
      if ( result ) {
        preloadCache.set( imageUri, result );
      }
      return result;
    } )
    .catch( ( ) => null )
    .finally( ( ) => {
      preloadInFlight.delete( imageUri );
    } );
  preloadInFlight.set( imageUri, promise );
  return promise;
}
