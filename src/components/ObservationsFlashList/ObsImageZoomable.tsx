import type { SharedZoomableImageRef } from "components/MediaViewer/SharedZoomableImage";
import SharedZoomableImage from "components/MediaViewer/SharedZoomableImage";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
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
  // Decode the local file at full resolution rather than at the tile's size
  fullResolution?: boolean;
  // Where a pinch is logged as this photo's framing. Left out, the caller
  // handles the new framing itself through onCropChange.
  logUri?: string;
  // Known dimensions, e.g. from subject detection. Without them the tile
  // learns the dimensions from the image once it loads.
  imageWidth?: number;
  imageHeight?: number;
  // The framing to start from. Without one the whole photo is shown, fitted
  // to the square.
  initialCrop?: NormalizedCrop | null;
  size: number;
  // Exposure multiplier drawn over the photo (1 = unchanged)
  brightness?: number;
  onCropChange?: (
    crop: NormalizedCrop,
    dims: { width: number; height: number },
  ) => void;
  testID?: string;
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

// Renders a grid photo with a two-finger pinch/pan that reuses the shared
// image-zoom engine (via SharedZoomableImage) so the gesture behaves
// identically to the crop editor, MediaViewer and IDing game. Single-finger
// panning is disabled so one finger scrolls the list; two fingers are
// required to pan or zoom.
const ObsImageZoomable = ( {
  uri,
  fullResolution,
  logUri,
  imageWidth: knownImageWidth,
  imageHeight: knownImageHeight,
  initialCrop,
  size,
  brightness,
  onCropChange,
  testID = "ObsList.photo",
}: Props ) => {
  const zoomRef = useRef<SharedZoomableImageRef | null>( null );
  const [loadedDims, setLoadedDims] = useState<{ width: number; height: number } | null>( null );
  const imageWidth = knownImageWidth || loadedDims?.width || 0;
  const imageHeight = knownImageHeight || loadedDims?.height || 0;

  const handleImageDimensionsChange = useCallback(
    ( dims: { width: number; height: number } ) => {
      setLoadedDims( prev => (
        prev?.width === dims.width && prev?.height === dims.height
          ? prev
          : dims
      ) );
    },
    [],
  );

  const cropPanContext = {
    imageWidth,
    imageHeight,
    viewportWidth: size,
    viewportHeight: size,
    cropSize: size,
  };

  // Once the user has framed the photo by hand, nothing arriving later (a
  // logged crop resolving, the image dimensions loading) may reframe it.
  const interactedRef = useRef( false );

  // On gesture end, report the framed region. Logged by logUri (the canonical
  // photo URL) rather than uri (which may be a tone-mapped or thumbnail file)
  // so the entry is findable on lookup.
  const handleInteractionEnd = useCallback( ( ) => {
    if ( !zoomRef.current ) return;
    if ( imageWidth <= 0 || imageHeight <= 0 ) return;
    interactedRef.current = true;
    const crop = imageZoomTransformToNormalizedCrop(
      imageWidth,
      imageHeight,
      size,
      size,
      size,
      zoomRef.current.readTransform( ),
    );
    if ( logUri ) saveAnimalCrop( logUri, crop );
    onCropChange?.( crop, { width: imageWidth, height: imageHeight } );
  }, [logUri, imageWidth, imageHeight, onCropChange, size] );

  // Frame the starting crop once the image dimensions are known.
  // applyTransform only sets shared values, so it is safe to call regardless
  // of layout timing (same path as the crop editor). A crop is applied a
  // single time per photo; the engine keeps the live transform thereafter. A
  // photo with no crop yet starts whole (the engine's resting state), and
  // still takes a crop that turns up later (a framing logged elsewhere
  // resolving) until the user pinches.
  const appliedRef = useRef( false );
  useEffect( ( ) => {
    if ( appliedRef.current || interactedRef.current || !initialCrop ) return;
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
      fullResolution={fullResolution}
      brightness={brightness}
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
      onImageDimensionsChange={handleImageDimensionsChange}
      testID={testID}
    />
  );
};

export default ObsImageZoomable;
