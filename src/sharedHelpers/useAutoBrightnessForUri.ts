import { useEffect, useState } from "react";

import { getBrightness, subscribeToBrightnessLog } from "./brightnessLog";
import ensureLocalImageForCrop from "./ensureLocalImageForCrop";
import measureImageBrightness from "./measureImageBrightness";
import type { NormalizedCrop } from "./normalizedCropTypes";

// Log-linear fit of brightness multiplier ~ (geometric-mean, median)
// luminance of the detected subject crop, against 100 human-picked "ideal
// brightness" labels from brightness_log_raw.json — see
// scripts/explore_brightness_crop_models.py. The opposite-signed
// coefficients key on how far the shadow tail drags the geomean below the
// median: a heavy dark tail under a mid-bright median (e.g. a backlit
// subject) predicts a strong brightening choice (LOOCV MAE 0.683 vs 0.756
// for the previous single-feature p10 fit and 0.974 for a naive constant
// guess).
const GEOMEAN_COEF = -4.167017;
const MEDIAN_COEF = 2.612363;
const INTERCEPT = 0.827665;

// geomean/median are luminances of the subject crop in [0, 1], as measured
// natively by measureImageBrightness.
const computeAdjustment = ( geomean: number, median: number ): number => {
  const adjustment = Math.exp(
    GEOMEAN_COEF * geomean + MEDIAN_COEF * median + INTERCEPT,
  );
  return Math.max( 0.4, Math.min( 3.0, adjustment ) );
};

// Cache keyed by `${uri}:${cropKey}` so a re-detected crop triggers a fresh measurement.
const cache = new Map<string, number>( );

const cacheKey = ( uri: string, crop: NormalizedCrop | null ) => ( crop
  ? `${uri}:${crop.x.toFixed( 3 )},${crop.y.toFixed( 3 )},`
    + `${crop.w.toFixed( 3 )},${crop.h.toFixed( 3 )}`
  : uri );

// uri    — image to measure; pass undefined to disable
// crop   — subject crop from detectSubjectInImage; pass undefined to wait for
//          detection to finish, null to measure the full image
const useAutoBrightnessForUri = (
  uri?: string,
  crop?: NormalizedCrop | null,
): number => {
  const [prevUri, setPrevUri] = useState<string | undefined>( uri );
  const [prevCrop, setPrevCrop] = useState<NormalizedCrop | null | undefined>( crop );
  const [brightnessLogVersion, setBrightnessLogVersion] = useState( 0 );

  const computeInitial = ( u: string, c: NormalizedCrop | null | undefined ) => {
    const logged = getBrightness( u );
    if ( logged !== null ) return logged;
    if ( c === undefined ) return 1.0; // still waiting for detection
    return cache.get( cacheKey( u, c ) ) ?? 1.0;
  };

  const [brightness, setBrightness] = useState<number>( ( ) => (
    uri
      ? computeInitial( uri, crop )
      : 1.0
  ) );

  if ( prevUri !== uri || prevCrop !== crop ) {
    setPrevUri( uri );
    setPrevCrop( crop );
    setBrightness( uri
      ? computeInitial( uri, crop )
      : 1.0 );
  }

  useEffect( ( ) => subscribeToBrightnessLog( ( ) => {
    setBrightnessLogVersion( v => v + 1 );
  } ), [] );

  useEffect( ( ) => {
    if ( !uri ) return ( ) => {};

    // Manual label always wins; no need to run detection.
    const logged = getBrightness( uri );
    if ( logged !== null ) {
      setBrightness( logged );
      return ( ) => {};
    }

    // crop===undefined means subject detection hasn't finished yet — wait.
    if ( crop === undefined ) return ( ) => {};

    const key = cacheKey( uri, crop );
    const existing = cache.get( key );
    if ( existing !== undefined ) {
      setBrightness( existing );
      return ( ) => {};
    }

    let cancelled = false;

    ( async ( ) => {
      try {
        const localUri = await ensureLocalImageForCrop( uri );
        if ( cancelled ) return;

        const luminance = await measureImageBrightness( localUri, crop );
        if ( cancelled || luminance === null ) return;

        const adjustment = computeAdjustment( luminance.geomean, luminance.median );
        cache.set( key, adjustment );
        setBrightness( adjustment );
      } catch {
        // Leave brightness at 1.0 on failure
      }
    } )( );

    return ( ) => {
      cancelled = true;
    };
  }, [uri, crop, brightnessLogVersion] );

  return brightness;
};

export default useAutoBrightnessForUri;
