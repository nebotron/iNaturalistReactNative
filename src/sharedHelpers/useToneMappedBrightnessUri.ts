import {
  exists, mkdir, stat, unlink,
} from "@dr.pogodin/react-native-fs";
import { brightnessAdjustedPath } from "appConstants/paths";
import { useEffect, useState } from "react";

import adjustImageBrightness from "./adjustImageBrightness";
import ensureLocalImageForCrop from "./ensureLocalImageForCrop";
import type { NormalizedCrop } from "./normalizedCropTypes";
import useAutoBrightnessForUri from "./useAutoBrightnessForUri";

// Thumbnail-sized output: this is only used for grid tiles, so there's no
// need to process (or cache) full-resolution images.
const MAX_DIMENSION = 640;
const CACHE_TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

// djb2 hash → stable hex filename for a given cache key
function hashKey( key: string ): string {
  let hash = 5381;
  for ( let i = 0; i < key.length; i += 1 ) {
    // eslint-disable-next-line no-bitwise
    hash = ( ( hash << 5 ) + hash ) ^ key.charCodeAt( i );
    // eslint-disable-next-line no-bitwise
    hash >>>= 0; // keep unsigned 32-bit
  }
  return hash.toString( 16 );
}

async function getCachedOrNull( filePath: string ): Promise<string | null> {
  if ( !( await exists( filePath ) ) ) return null;
  const info = await stat( filePath );
  const age = Date.now() - new Date( info.mtime ).getTime();
  if ( age > CACHE_TTL_MS ) {
    await unlink( filePath );
    return null;
  }
  return `file://${filePath}`;
}

const cacheKey = ( uri: string, adjustment: number ) => `${uri}:${adjustment.toFixed( 3 )}`;

const cache = new Map<string, string>( );

// Given a source uri and a detected subject crop, returns a uri for a version
// of the image with a detail-preserving tone curve baked in (native
// adjustImageBrightness) rather than a live CSS `brightness` filter — so
// highlights can't clip to white and shadows can't crush to black. Falls
// back to the original uri while unadjusted or still processing.
const useToneMappedBrightnessUri = (
  uri?: string,
  crop?: NormalizedCrop | null,
): string | undefined => {
  const adjustment = useAutoBrightnessForUri( uri, crop );

  const computeInitial = ( u: string | undefined, adj: number ) => {
    if ( !u || adj === 1.0 ) return u;
    return cache.get( cacheKey( u, adj ) ) ?? u;
  };

  const [prevUri, setPrevUri] = useState<string | undefined>( uri );
  const [prevAdjustment, setPrevAdjustment] = useState<number>( adjustment );
  const [processedUri, setProcessedUri] = useState<string | undefined>(
    ( ) => computeInitial( uri, adjustment ),
  );

  if ( prevUri !== uri || prevAdjustment !== adjustment ) {
    setPrevUri( uri );
    setPrevAdjustment( adjustment );
    setProcessedUri( computeInitial( uri, adjustment ) );
  }

  useEffect( ( ) => {
    if ( !uri || adjustment === 1.0 ) return ( ) => {};

    const key = cacheKey( uri, adjustment );
    if ( cache.has( key ) ) return ( ) => {};

    let cancelled = false;

    ( async ( ) => {
      try {
        const destPath = `${brightnessAdjustedPath}/${hashKey( key )}.jpg`;
        const cached = await getCachedOrNull( destPath );
        if ( cancelled ) return;
        if ( cached ) {
          cache.set( key, cached );
          setProcessedUri( cached );
          return;
        }

        await mkdir( brightnessAdjustedPath );
        const localUri = await ensureLocalImageForCrop( uri );
        if ( cancelled ) return;

        const result = await adjustImageBrightness(
          localUri,
          adjustment,
          MAX_DIMENSION,
          destPath,
        );
        if ( cancelled || !result ) return;

        cache.set( key, result );
        setProcessedUri( result );
      } catch {
        // Leave the unadjusted image showing on failure
      }
    } )( );

    return ( ) => {
      cancelled = true;
    };
  }, [uri, adjustment] );

  return processedUri;
};

export default useToneMappedBrightnessUri;
