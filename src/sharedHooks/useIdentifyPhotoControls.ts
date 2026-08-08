import type { IdentifyPhotoHandle } from "components/MediaViewer/IdentifyPhoto";
import { clampZoom, MIN_ZOOM, zoomPosToScale } from "components/MediaViewer/IdentifyPhoto";
import type { RefObject } from "react";
import { useCallback, useEffect, useState } from "react";
import useIdentifyPhotoBrightness from "sharedHooks/useIdentifyPhotoBrightness";

// The zoom-slider and exposure-slider wiring every IdentifyPhoto screen needs:
// zoom resets when the visible photo changes, the slider stays in sync with
// pinch/double-tap/subject-framing zoom, and brightness rounds through
// useIdentifyPhotoBrightness (which resets itself on photo change).
const useIdentifyPhotoControls = (
  currentPhotoUrl: string | undefined,
  photoRef: RefObject<IdentifyPhotoHandle | null>,
) => {
  const [zoomScale, setZoomScale] = useState( MIN_ZOOM );

  const {
    brightness, brightnessStops, setBrightnessStops, handleBrightnessComplete,
  } = useIdentifyPhotoBrightness( currentPhotoUrl );

  useEffect( ( ) => {
    setZoomScale( MIN_ZOOM );
  }, [currentPhotoUrl] );

  // Keep the zoom slider in sync with pinch/double-tap/subject-framing zoom.
  const handleScaleChange = useCallback(
    ( scale: number ) => setZoomScale( clampZoom( scale ) ),
    [],
  );

  // Slider position 0..1 -> scale, driven back into the image.
  const handleZoomChange = useCallback( ( pos: number ) => {
    const scale = zoomPosToScale( pos );
    setZoomScale( scale );
    photoRef.current?.applyZoom( scale );
  }, [photoRef] );

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
