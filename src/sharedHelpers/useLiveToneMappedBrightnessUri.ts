import { mkdir } from "@dr.pogodin/react-native-fs";
import { brightnessAdjustedPath } from "appConstants/paths";
import { useEffect, useState } from "react";

import adjustImageBrightness from "./adjustImageBrightness";
import ensureLocalImageForCrop from "./ensureLocalImageForCrop";

const DEBOUNCE_MS = 100;

const cache = new Map<string, string>( );
const cacheKey = ( uri: string, adjustment: number ) => `${uri}:${adjustment.toFixed( 2 )}`;

// djb2 hash → stable hex filename for a given cache key (uris can be long
// remote urls, so hash rather than sanitize-and-use-directly as a filename)
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

let outputDirReady: Promise<void> | null = null;
const ensureOutputDir = ( ) => {
  if ( !outputDirReady ) outputDirReady = mkdir( brightnessAdjustedPath ).catch( ( ) => {} );
  return outputDirReady;
};

// Debounces a live-adjusted brightness value (e.g. from a slider) and
// applies it via the same detail-preserving gamma tone curve used for auto
// brightness (see adjustImageBrightness), so the live preview matches what
// gets saved. While a new adjustment is being processed, keeps showing the
// most recently computed tone-mapped preview rather than reverting to the
// raw uri, so the preview never flashes back to unadjusted mid-drag.
const useLiveToneMappedBrightnessUri = (
  uri: string | undefined,
  adjustment: number,
  maxDimension: number,
): string | undefined => {
  const [prevUri, setPrevUri] = useState( uri );
  const [processedUri, setProcessedUri] = useState<string | undefined>( uri );

  if ( prevUri !== uri ) {
    setPrevUri( uri );
    setProcessedUri( uri );
  }

  useEffect( ( ) => {
    if ( !uri || adjustment === 1.0 ) {
      setProcessedUri( uri );
      return ( ) => {};
    }

    const key = cacheKey( uri, adjustment );
    const cached = cache.get( key );
    if ( cached ) {
      setProcessedUri( cached );
      return ( ) => {};
    }

    let cancelled = false;
    const timer = setTimeout( ( ) => {
      ( async ( ) => {
        try {
          await ensureOutputDir( );
          const localUri = await ensureLocalImageForCrop( uri );
          if ( cancelled ) return;

          const outputPath = `${brightnessAdjustedPath}/live-${hashKey( key )}.jpg`;
          const result = await adjustImageBrightness(
            localUri,
            adjustment,
            maxDimension,
            outputPath,
          );
          if ( cancelled || !result ) return;

          cache.set( key, result );
          setProcessedUri( result );
        } catch {
          // Leave the current preview showing on failure
        }
      } )( );
    }, DEBOUNCE_MS );

    return ( ) => {
      cancelled = true;
      clearTimeout( timer );
    };
  }, [uri, adjustment, maxDimension] );

  return processedUri;
};

export default useLiveToneMappedBrightnessUri;
