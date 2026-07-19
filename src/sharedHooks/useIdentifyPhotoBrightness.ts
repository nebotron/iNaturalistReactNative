import { useCallback, useEffect, useState } from "react";
import { getBrightness, saveBrightness } from "sharedHelpers/brightnessLog";
import useAutoBrightnessForUri from "sharedHelpers/useAutoBrightnessForUri";

// Exposure slider in stops (EV); the gain applied to the image is 2^stops.
export const EXPOSURE_STOPS_MIN = -1;
export const EXPOSURE_STOPS_MAX = 4;
export const EXPOSURE_STOPS_DEFAULT = 0;
export const stopsToGain = ( stops: number ) => 2 ** stops;
export const gainToStops = ( gain: number ) => Math.min(
  EXPOSURE_STOPS_MAX,
  Math.max( EXPOSURE_STOPS_MIN, Math.log2( gain ) ),
);

// Computes the display brightness for the current photo. Auto-brightness is
// always on and multiplicative: the computed gain is applied live as a flat
// CSS brightness filter. The exposure slider shows the *total* effective
// stops: while there's no manual override it tracks the auto-brightness
// baseline live (including once the async computation resolves), so the thumb
// visibly moves when auto-brightness adjusts the photo; dragging it sets an
// absolute manual override for that photo.
const useIdentifyPhotoBrightness = ( currentPhotoUrl?: string ) => {
  const [manualStops, setManualStops] = useState<number | null>( null );

  // skipManualOverride=true: this hook already layers manualStops on top of
  // the auto baseline below, so the baseline itself must stay the pure model
  // prediction -- otherwise saving a manual value here would feed back into
  // its own baseline.
  const autoGain = useAutoBrightnessForUri( currentPhotoUrl, null, true );
  const brightnessStops = manualStops ?? gainToStops( autoGain );
  const brightness = stopsToGain( brightnessStops );

  // Load any previously-saved brightness whenever the visible photo changes,
  // so saved adjustments round-trip; otherwise clear the override so the
  // slider follows the auto-brightness baseline.
  useEffect( ( ) => {
    const saved = currentPhotoUrl
      ? getBrightness( currentPhotoUrl )
      : null;
    setManualStops( saved !== null
      ? gainToStops( saved )
      : null );
  }, [currentPhotoUrl] );

  const handleBrightnessComplete = useCallback( ( value: number ) => {
    setManualStops( value );
    if ( currentPhotoUrl ) saveBrightness( currentPhotoUrl, stopsToGain( value ) );
  }, [currentPhotoUrl] );

  return {
    brightness,
    brightnessStops,
    setBrightnessStops: setManualStops,
    handleBrightnessComplete,
  };
};

export default useIdentifyPhotoBrightness;
