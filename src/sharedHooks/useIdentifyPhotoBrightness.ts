import { useCallback, useEffect, useState } from "react";
import { getBrightness, saveBrightness } from "sharedHelpers/brightnessLog";
import useAutoBrightnessForUri from "sharedHelpers/useAutoBrightnessForUri";
import useToneMappedBrightnessUri from "sharedHelpers/useToneMappedBrightnessUri";
import { useLayoutPrefs } from "sharedHooks";
import { AUTO_BRIGHTNESS_MODE } from "stores/createLayoutSlice";

// Exposure slider in stops (EV); the gain applied to the image is 2^stops.
export const EXPOSURE_STOPS_MIN = -1;
export const EXPOSURE_STOPS_MAX = 4;
export const EXPOSURE_STOPS_DEFAULT = 0;
export const stopsToGain = ( stops: number ) => 2 ** stops;
export const gainToStops = ( gain: number ) => Math.min(
  EXPOSURE_STOPS_MAX,
  Math.max( EXPOSURE_STOPS_MIN, Math.log2( gain ) ),
);

// Computes the display brightness/uri for the current photo from the
// app-wide auto-brightness mode (Off / Multiply / Gamma), which always wins
// -- live, including mid-drag. The exposure slider shows the *total*
// effective stops: while there's no manual override it tracks the
// auto-brightness baseline live (including once the async computation
// resolves), so the thumb visibly moves when auto-brightness adjusts the
// photo; dragging it sets an absolute manual override for that photo.
const useIdentifyPhotoBrightness = ( currentPhotoUrl?: string ) => {
  const { autoBrightnessMode } = useLayoutPrefs( );
  const [manualStops, setManualStops] = useState<number | null>( null );

  const isGammaMode = autoBrightnessMode === AUTO_BRIGHTNESS_MODE.GAMMA;
  const isMultiplyMode = autoBrightnessMode === AUTO_BRIGHTNESS_MODE.MULTIPLY;
  const autoBrightnessUri = ( isGammaMode || isMultiplyMode )
    ? currentPhotoUrl
    : undefined;
  // skipManualOverride=true: this hook already layers manualStops on top of
  // the auto baseline below, so the baseline itself must stay the pure model
  // prediction -- otherwise saving a manual value here would feed back into
  // its own baseline and rebake a new Gamma image moments after release.
  const autoGain = useAutoBrightnessForUri(
    isMultiplyMode
      ? autoBrightnessUri
      : undefined,
    null,
    true,
  );
  const toneMappedUri = useToneMappedBrightnessUri(
    isGammaMode
      ? autoBrightnessUri
      : undefined,
    null,
    true,
  );
  const baseGain = isMultiplyMode
    ? autoGain
    : 1;
  const brightnessStops = manualStops ?? gainToStops( baseGain );
  const brightness = stopsToGain( brightnessStops );
  const displayUri = isGammaMode
    ? toneMappedUri
    : undefined;

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
    displayUri,
    brightnessStops,
    setBrightnessStops: setManualStops,
    handleBrightnessComplete,
  };
};

export default useIdentifyPhotoBrightness;
