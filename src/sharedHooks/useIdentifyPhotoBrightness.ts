import { useCallback, useEffect, useState } from "react";
import { getBrightness, saveBrightness } from "sharedHelpers/brightnessLog";

// Exposure slider in stops (EV); the gain applied to the image is 2^stops.
export const EXPOSURE_STOPS_MIN = -1;
export const EXPOSURE_STOPS_MAX = 4;
export const EXPOSURE_STOPS_DEFAULT = 0;
export const stopsToGain = ( stops: number ) => 2 ** stops;
export const gainToStops = ( gain: number ) => Math.min(
  EXPOSURE_STOPS_MAX,
  Math.max( EXPOSURE_STOPS_MIN, Math.log2( gain ) ),
);

// Computes the display brightness for the current photo. The exposure slider
// starts at the neutral default; dragging it sets a manual adjustment for
// that photo, applied live as a flat CSS brightness filter.
const useIdentifyPhotoBrightness = ( currentPhotoUrl?: string ) => {
  const [manualStops, setManualStops] = useState<number | null>( null );

  const brightnessStops = manualStops ?? EXPOSURE_STOPS_DEFAULT;
  const brightness = stopsToGain( brightnessStops );

  // Load any previously-saved brightness whenever the visible photo changes,
  // so saved adjustments round-trip; otherwise reset to the default.
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
