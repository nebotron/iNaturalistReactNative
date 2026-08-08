import type { SharedZoomableImageRef } from "components/MediaViewer/SharedZoomableImage";
import SharedZoomableImage from "components/MediaViewer/SharedZoomableImage";
import React, {
  useCallback,
  useEffect,
  useRef,
} from "react";
import { saveAnimalCrop } from "sharedHelpers/animalCropLog";
import { computeCropPanTranslateLimits } from "sharedHelpers/cropPanTranslateLimits";
import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { computeContainRect } from "sharedHelpers/normalizedCropTypes";

const MAX_SCALE = 100;

interface Props {
  uri: string;
  logUri: string;
  imageWidth: number;
  imageHeight: number;
  initialCrop: NormalizedCrop;
  size: number;
}

// Builds a transform that frames a normalized crop centered in the square tile.
// Uses fitCropScale so the whole subject fits; this may letterbox when the
// subject spans a large portion of a non-square image.
const frameCropTransform = (
  crop: NormalizedCrop,
  size: number,
  imageWidth: number,
  imageHeight: number,
): ImageZoomTransform => {
  const contain = computeContainRect( size, size, imageWidth, imageHeight );
  if ( contain.width <= 0 || contain.height <= 0 ) {
    return {
      scale: 1, translateX: 0, translateY: 0, focalX: 0, focalY: 0,
    };
  }
  const fitCropScale = Math.min(
    size / ( crop.w * contain.width ),
    size / ( crop.h * contain.height ),
  );
  const scale = Math.min( MAX_SCALE, fitCropScale );
  const center = size / 2;
  const cropCenterX = contain.left + ( crop.x + crop.w / 2 ) * contain.width;
  const cropCenterY = contain.top + ( crop.y + crop.h / 2 ) * contain.height;
  return {
    scale,
    translateX: 0,
    translateY: 0,
    focalX: ( center - cropCenterX ) * scale,
    focalY: ( center - cropCenterY ) * scale,
  };
};

// Renders an Explore-grid photo cropped to the detected subject, with a
// two-finger pinch/pan that reuses the shared image-zoom engine (via
// SharedZoomableImage) so the gesture behaves identically to the crop editor,
// MediaViewer and IDing game. Single-finger panning is disabled so one finger
// scrolls the list; two fingers are required to pan or zoom.
const ObsImageZoomable = ( {
  uri,
  logUri,
  imageWidth,
  imageHeight,
  initialCrop,
  size,
}: Props ) => {
  const zoomRef = useRef<SharedZoomableImageRef | null>( null );

  const cropPanContext = {
    imageWidth,
    imageHeight,
    viewportWidth: size,
    viewportHeight: size,
    cropSize: size,
  };

  // On gesture end, immediately log the framed region as a ground-truth crop.
  // Keyed by logUri (the canonical remote photo URL) rather than uri (which
  // may be a tone-mapped local file path) so the entry is findable on lookup.
  const handleInteractionEnd = useCallback( ( ) => {
    if ( !zoomRef.current ) return;
    const crop = imageZoomTransformToNormalizedCrop(
      imageWidth,
      imageHeight,
      size,
      size,
      size,
      zoomRef.current.readTransform( ),
    );
    saveAnimalCrop( logUri, crop );
  }, [logUri, imageWidth, imageHeight, size] );

  // Frame the detected (or previously logged) crop once the image dimensions
  // are known. applyTransform only sets shared values, so it is safe to call
  // regardless of layout timing (same path as the crop editor). Applied a
  // single time per photo; the engine keeps the live transform thereafter.
  const appliedRef = useRef( false );
  useEffect( ( ) => {
    if ( appliedRef.current ) return;
    const zoom = zoomRef.current;
    if ( !zoom ) return;
    if ( size <= 0 || imageWidth <= 0 || imageHeight <= 0 ) return;
    const framed = frameCropTransform( initialCrop, size, imageWidth, imageHeight );
    // Clamp the framing so a subject near an edge doesn't shift the image past
    // that edge (matches the crop clamping applied during gestures).
    const limits = computeCropPanTranslateLimits( cropPanContext, framed );
    const clamp = ( v: number, lo: number, hi: number ) => Math.min( Math.max( v, lo ), hi );
    zoom.applyTransform( {
      ...framed,
      focalX: clamp( framed.focalX, limits.minTotalTranslateX, limits.maxTotalTranslateX ),
      focalY: clamp( framed.focalY, limits.minTotalTranslateY, limits.maxTotalTranslateY ),
    } );
    appliedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, size, imageWidth, imageHeight, initialCrop] );

  return (
    <SharedZoomableImage
      ref={zoomRef}
      uri={uri}
      style={{ width: size, height: size }}
      // scale 1 renders the whole image contained (letterboxed) in the square, so
      // allowing pinch down to 1 lets the user shrink the photo until it fully fits.
      minScale={1}
      maxScale={MAX_SCALE}
      isPinchEnabled
      isSingleFingerPanEnabled={false}
      isDoubleTapEnabled={false}
      isSingleTapEnabled={false}
      cropPanContext={cropPanContext}
      onInteractionEnd={handleInteractionEnd}
      testID="ObsList.photo"
    />
  );
};

export default ObsImageZoomable;
