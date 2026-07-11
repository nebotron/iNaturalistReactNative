import { mkdir } from "@dr.pogodin/react-native-fs";
import { brightnessAdjustedPath } from "appConstants/paths";
import { useEffect, useState } from "react";

import adjustImageBrightness from "./adjustImageBrightness";
import ensureLocalImageForCrop from "./ensureLocalImageForCrop";

const DEBOUNCE_MS = 100;

const cache = new Map<string, string>( );
const cacheKey = ( uri: string, adjustment: number ) => `${uri}:${adjustment.toFixed( 2 )}`;

let outputDirReady: Promise<void> | null = null;
const ensureOutputDir = ( ) => {
  if ( !outputDirReady ) outputDirReady = mkdir( brightnessAdjustedPath ).catch( ( ) => {} );
  return outputDirReady;
};

// Debounces a live-adjusted brightness value (e.g. from a slider) and
// applies it via the same detail-preserving gamma tone curve used for auto
// brightness (see adjustImageBrightness), so the live preview matches what
// gets saved. Falls back to the raw uri while unadjusted or still processing.
const useLiveToneMappedBrightnessUri = (
  uri: string | undefined,
  adjustment: number,
  maxDimension: number,
): string | undefined => {
  const computeInitial = ( u: string | undefined, adj: number ) => {
    if ( !u || adj === 1.0 ) return u;
    return cache.get( cacheKey( u, adj ) ) ?? u;
  };

  const [prevUri, setPrevUri] = useState( uri );
  const [prevAdjustment, setPrevAdjustment] = useState( adjustment );
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
    const timer = setTimeout( ( ) => {
      ( async ( ) => {
        try {
          await ensureOutputDir( );
          const localUri = await ensureLocalImageForCrop( uri );
          if ( cancelled ) return;

          const outputPath = `${brightnessAdjustedPath}/live-`
            + `${key.replace( /[^a-z0-9]/gi, "_" )}.jpg`;
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
