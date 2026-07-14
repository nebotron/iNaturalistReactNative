import {
  useCallback, useEffect, useRef, useState,
} from "react";
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

  // A manually saved brightness wins over the global auto-brightness switch
  // (Off / Multiply / Gamma) so a saved label round-trips when revisiting a
  // photo -- but an explicit press of the toggle (see the effect below)
  // always retakes control of the photo currently on screen, so the switch
  // is never silently a no-op.
  const [manualOverrideActive, setManualOverrideActive] = useState(
    ( ) => !!currentPhotoUrl && getBrightness( currentPhotoUrl ) !== null,
  );

  const isGammaMode = !manualOverrideActive && autoBrightnessMode === AUTO_BRIGHTNESS_MODE.GAMMA;
  const isMultiplyMode = !manualOverrideActive
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
    setManualOverrideActive( saved !== null );
    setBrightnessStops( saved
      ? gainToStops( saved )
      : EXPOSURE_STOPS_DEFAULT );
  }, [currentPhotoUrl] );

  // An explicit press of the auto-brightness toggle always retakes control of
  // the photo on screen, even if it has a saved manual brightness -- so the
  // toggle is never silently a no-op. (Skipped on mount/photo-change, which
  // are handled by the effect above.)
  const prevAutoBrightnessModeRef = useRef( autoBrightnessMode );
  useEffect( ( ) => {
    if ( prevAutoBrightnessModeRef.current === autoBrightnessMode ) return;
    prevAutoBrightnessModeRef.current = autoBrightnessMode;
    setManualOverrideActive( false );
    setBrightnessStops( EXPOSURE_STOPS_DEFAULT );
  }, [autoBrightnessMode] );

  const handleBrightnessComplete = useCallback( ( value: number ) => {
    setBrightnessStops( value );
    setManualOverrideActive( true );
    if ( currentPhotoUrl ) saveBrightness( currentPhotoUrl, baseGain * stopsToGain( value ) );
  }, [currentPhotoUrl, baseGain] );

  return {
    brightness, displayUri, brightnessStops, setBrightnessStops, handleBrightnessComplete,
  };
};

export default useIdentifyPhotoBrightness;
