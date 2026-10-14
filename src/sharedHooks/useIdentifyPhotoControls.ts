import { clampZoom, MIN_ZOOM, zoomPosToScale } from "components/MediaViewer/IdentifyPhoto";
import {
  useCallback, useEffect, useRef, useState,
} from "react";
import useIdentifyPhotoBrightness from "sharedHooks/useIdentifyPhotoBrightness";

interface Options {
  // Identifies the photo for the brightness log: its remote url on the identify
  // screens, an upload-scoped key in the crop editor. Brightness loads and
  // saves against this, so it also decides when the exposure slider resets.
  brightnessKey?: string;
  // Rescales the image. The identify screens hand this to IdentifyPhoto; the
  // crop editor rescales around the crop box instead, which is why this is a
  // callback rather than a ref to one particular component.
  applyZoom?: ( scale: number ) => void;
  // Extra work on every scale change, whatever its source (slider, pinch,
  // double-tap, initial framing) — the crop editor recomputes its downsize
  // warning here.
  onScaleChange?: ( scale: number ) => void;
  // Zoom snaps back to MIN_ZOOM whenever brightnessKey changes. Screens that
  // frame each new photo themselves (the crop editor applies a stored crop)
  // opt out, so the slider is never briefly wrong before that framing lands.
  skipZoomReset?: boolean;
}

// The zoom-slider and exposure-slider wiring shared by the identify screens and
// the crop editor: the slider tracks pinch/double-tap/programmatic zoom, and
// brightness rounds through useIdentifyPhotoBrightness.
const useIdentifyPhotoControls = ( {
  brightnessKey,
  applyZoom,
  onScaleChange,
  skipZoomReset = false,
}: Options = {} ) => {
  const [zoomScale, setZoomScale] = useState( MIN_ZOOM );

  const {
    brightness, brightnessStops, setBrightnessStops, handleBrightnessComplete,
  } = useIdentifyPhotoBrightness( brightnessKey );

  // Held in refs so callers can pass inline closures without the returned
  // handlers changing identity on every render.
  const applyZoomRef = useRef( applyZoom );
  applyZoomRef.current = applyZoom;
  const onScaleChangeRef = useRef( onScaleChange );
  onScaleChangeRef.current = onScaleChange;

  useEffect( ( ) => {
    if ( skipZoomReset ) return;
    setZoomScale( MIN_ZOOM );
  }, [brightnessKey, skipZoomReset] );

  // Keep the zoom slider in sync with pinch/double-tap/subject-framing zoom.
  const handleScaleChange = useCallback( ( scale: number ) => {
    setZoomScale( clampZoom( scale ) );
    onScaleChangeRef.current?.( scale );
  }, [] );

  // Slider position 0..1 -> scale, driven back into the image.
  const handleZoomChange = useCallback( ( pos: number ) => {
    const scale = zoomPosToScale( pos );
    setZoomScale( scale );
    applyZoomRef.current?.( scale );
  }, [] );

  // Update the exposure override live; the image re-renders with the new
  // brightness filter each tick.
  const handleBrightnessChange = useCallback( ( value: number ) => {
    setBrightnessStops( value );
  }, [setBrightnessStops] );

  return {
    brightness,
    brightnessStops,
    handleBrightnessChange,
    handleBrightnessComplete,
    handleScaleChange,
    handleZoomChange,
    zoomScale,
  };
};

export default useIdentifyPhotoControls;
