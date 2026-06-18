import { useEffect, useState } from "react";

import { getBrightness, subscribeToBrightnessLog } from "./brightnessLog";
import ensureLocalImageForCrop from "./ensureLocalImageForCrop";
import measureImageBrightness from "./measureImageBrightness";

// Images with luminance within this fraction of the target need no adjustment.
const TARGET_LUMINANCE = 0.45;
const TOLERANCE_FACTOR = 0.15;

const computeAdjustment = ( luminance: number ): number => {
  const adjustment = TARGET_LUMINANCE / luminance;
  if ( Math.abs( adjustment - 1.0 ) < TOLERANCE_FACTOR ) return 1.0;
  return Math.max( 0.4, Math.min( 3.0, adjustment ) );
};

const cache = new Map<string, number>( );

const useAutoBrightnessForUri = ( uri?: string ): number => {
  const [prevUri, setPrevUri] = useState<string | undefined>( uri );
  const [brightnessLogVersion, setBrightnessLogVersion] = useState( 0 );

  const computeInitial = ( u: string ) => {
    const logged = getBrightness( u );
    if ( logged !== null ) return logged;
    return cache.get( u ) ?? 1.0;
  };

  const [brightness, setBrightness] = useState<number>( ( ) => (
    uri ? computeInitial( uri ) : 1.0
  ) );

  if ( prevUri !== uri ) {
    setPrevUri( uri );
    setBrightness( uri ? computeInitial( uri ) : 1.0 );
  }

  useEffect( ( ) => subscribeToBrightnessLog( ( ) => {
    setBrightnessLogVersion( v => v + 1 );
  } ), [] );

  useEffect( ( ) => {
    if ( !uri ) return ( ) => {};

    const logged = getBrightness( uri );
    if ( logged !== null ) {
      setBrightness( logged );
      return ( ) => {};
    }

    const existing = cache.get( uri );
    if ( existing !== undefined ) {
      setBrightness( existing );
      return ( ) => {};
    }

    let cancelled = false;

    ( async ( ) => {
      try {
        const localUri = await ensureLocalImageForCrop( uri );
        if ( cancelled ) return;

        const luminance = await measureImageBrightness( localUri );
        if ( cancelled || luminance === null ) return;

        const adjustment = computeAdjustment( luminance );
        cache.set( uri, adjustment );
        setBrightness( adjustment );
      } catch {
        // Leave brightness at 1.0 on failure
      }
    } )( );

    return ( ) => {
      cancelled = true;
    };
  }, [uri, brightnessLogVersion] );

  return brightness;
};

export default useAutoBrightnessForUri;
