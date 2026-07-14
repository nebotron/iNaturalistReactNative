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

// Computes the display brightness/uri for the current photo, combining any
// manually-saved brightness with the app-wide auto-brightness mode (Off /
// Multiply / Gamma), and exposes the exposure-slider state used to adjust it.
const useIdentifyPhotoBrightness = ( currentPhotoUrl?: string ) => {
  const { autoBrightnessMode } = useLayoutPrefs( );
  const [brightnessStops, setBrightnessStops] = useState( EXPOSURE_STOPS_DEFAULT );

  const savedBrightness = currentPhotoUrl
    ? getBrightness( currentPhotoUrl )
    : null;
  const hasManualBrightness = savedBrightness !== null;

  const isGammaMode = !hasManualBrightness && autoBrightnessMode === AUTO_BRIGHTNESS_MODE.GAMMA;
  const isMultiplyMode = !hasManualBrightness
    && autoBrightnessMode === AUTO_BRIGHTNESS_MODE.MULTIPLY;
  const autoBrightnessUri = ( isGammaMode || isMultiplyMode )
    ? currentPhotoUrl
    : undefined;
  const autoGain = useAutoBrightnessForUri(
    isMultiplyMode
      ? autoBrightnessUri
      : undefined,
    null,
  );
  const toneMappedUri = useToneMappedBrightnessUri(
    isGammaMode
      ? autoBrightnessUri
      : undefined,
    null,
  );
  const baseGain = isMultiplyMode
    ? autoGain
    : 1;
  const brightness = baseGain * stopsToGain( brightnessStops );
  const displayUri = isGammaMode
    ? toneMappedUri
    : undefined;

  // Load any previously-saved brightness whenever the visible photo changes,
  // so saved adjustments round-trip. Auto-brightness (when active) is
  // applied separately as a baseline, so the slider itself resets to 0 stops.
  useEffect( ( ) => {
    const saved = currentPhotoUrl
      ? getBrightness( currentPhotoUrl )
      : null;
    setBrightnessStops( saved
      ? gainToStops( saved )
      : EXPOSURE_STOPS_DEFAULT );
  }, [currentPhotoUrl] );

  const handleBrightnessComplete = useCallback( ( value: number ) => {
    setBrightnessStops( value );
    if ( currentPhotoUrl ) saveBrightness( currentPhotoUrl, baseGain * stopsToGain( value ) );
  }, [currentPhotoUrl, baseGain] );

  return {
    brightness, displayUri, brightnessStops, setBrightnessStops, handleBrightnessComplete,
  };
};

export default useIdentifyPhotoBrightness;
