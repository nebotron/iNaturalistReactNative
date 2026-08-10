import type { SharedZoomableImageRef } from "components/MediaViewer/SharedZoomableImage";
import SharedZoomableImage from "components/MediaViewer/SharedZoomableImage";
import React, {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Image, StyleSheet, View } from "react-native";
import { computeCropPanTranslateLimits } from "sharedHelpers/cropPanTranslateLimits";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import { log } from "sharedHelpers/logger";
import {
  normalizedCropToImageZoomTransform,
} from "sharedHelpers/normalizedCropToImageZoomTransform";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import useDeviceImageThumbnail from "sharedHelpers/useDeviceImageThumbnail";
import useThumbnailSubjectDetection from "sharedHelpers/useThumbnailSubjectDetection";
import colors from "styles/tailwindColors";

const logger = log.extend( "GroupPhotoCropImage" );

const MAX_SCALE = 100;
// Crops round-trip through a screen-space transform, so a gesture that only
// tapped (or barely moved) comes back as a crop that differs in the last few
// decimals. Below this it isn't a crop the user made.
const CROP_EPSILON = 0.001;

// Pixels the photo file itself is generated at. Set well above any single-shot
// camera photo (even a 108MP sensor's long edge is well under this) so the cell
// always draws the photo at its true native resolution; the cap only exists so
// a stitched panorama can't produce a bitmap the size of the whole grid.
// createThumbnail never upscales past the source's actual resolution (ImageIO's
// kCGImageSourceThumbnailMaxPixelSize, and PHImageManager's targetSize, are
// both ceilings), so this is a safety valve, not a target.
const FULL_RESOLUTION_MAX_PIXEL = 16384;

const styles = StyleSheet.create( {
  overlay: StyleSheet.absoluteFillObject,
  // The photo is drawn contained rather than cover-cropped, so anything the
  // grid's own thumbnail would show through the letterbox is covered. Only
  // painted once this photo has actually decoded, so the backdrop can never
  // black out a cell whose image hasn't arrived yet.
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.black,
  },
  // Mounted (so the ref exists and the crop can be applied) but not yet
  // showing the crop, which would otherwise flash the whole photo for a frame.
  unframed: {
    opacity: 0,
  },
} );

// Photos this process has already decoded once. A cell landing on one of them
// draws from a warm image cache, so it can reveal its crop on the first frame
// rather than waiting out another onLoad. Waiting was what made a photo
// scrolled back to appear uncropped — the overlay stayed hidden and the grid's
// own thumbnail showed through underneath.
const paintedImages = new Set<string>( );

const cropsMatch = ( a: NormalizedCrop, b: NormalizedCrop ) => (
  Math.abs( a.x - b.x ) < CROP_EPSILON
  && Math.abs( a.y - b.y ) < CROP_EPSILON
  && Math.abs( a.w - b.w ) < CROP_EPSILON
  && Math.abs( a.h - b.h ) < CROP_EPSILON
);

interface Props {
  // The uncropped original the crop is expressed against
  cropSourceUri: string;
  // Crop already saved for this photo, which wins over subject detection
  savedCrop?: NormalizedCrop | null;
  // Laid-out (square) size of the grid cell
  size: number;
  onCropChange: ( crop: NormalizedCrop ) => void;
}

// Renders a Group Photos grid cell cropped to its subject, with a two-finger
// pinch/pan that reframes the crop. Everything below the gesture is shared with
// the crop editor and the Explore grid: the same zoom engine (via
// SharedZoomableImage), the same subject detector, and the same crop <->
// transform math. Single-finger panning is disabled so one finger still
// scrolls the list.
const GroupPhotoCropImage = ( {
  cropSourceUri,
  savedCrop,
  size,
  onCropChange,
}: Props ) => {
  const zoomRef = useRef<SharedZoomableImageRef | null>( null );
  // The crop the photo is currently framed to. Null means it still needs
  // framing, which happens once per photo; the zoom engine owns the transform
  // from then on.
  const [framedCrop, setFramedCrop] = useState<NormalizedCrop | null>( null );
  // The photo the image below has actually painted. A cell whose crop and
  // photo are both already cached — every cell recycled by scrolling, and
  // every cell that shifts up when one is deleted — frames itself on its first
  // render, while its image is still decoding. Showing the overlay then is what
  // turned those cells black.
  const [loadedUri, setLoadedUri] = useState<string | null>( null );
  const [prevCropSourceUri, setPrevCropSourceUri] = useState( cropSourceUri );

  // Synchronously reset when a recycled cell lands on a different photo, so its
  // first render never frames the new photo with the previous one's crop.
  if ( prevCropSourceUri !== cropSourceUri ) {
    setPrevCropSourceUri( cropSourceUri );
    setFramedCrop( null );
  }

  // Routed through the native thumbnail generator (rather than an <Image>
  // reading cropSourceUri directly) so orientation is baked in: a raw device
  // photo can carry any EXIF orientation, and RN's <Image> doesn't reliably
  // re-apply it, which showed up as this layer rendering rotated 90°.
  const fullResolutionUri = useDeviceImageThumbnail(
    cropSourceUri,
    FULL_RESOLUTION_MAX_PIXEL,
  );

  const detection = useThumbnailSubjectDetection(
    cropSourceUri,
    fullResolutionUri,
    Boolean( savedCrop ),
  );

  const imageWidth = detection?.imageWidth ?? 0;
  const imageHeight = detection?.imageHeight ?? 0;
  // A cached detection can carry a crop from before the user's last gesture, so
  // the crop saved on the photo always wins (same as the crop editor).
  const initialCrop = savedCrop ?? detection?.crop ?? null;
  const ready = Boolean( fullResolutionUri ) && imageWidth > 0 && imageHeight > 0 && size > 0;

  const cropPanContext = {
    imageWidth,
    imageHeight,
    viewportWidth: size,
    viewportHeight: size,
    cropSize: size,
  };

  // Frame the detected (or saved) crop once the image dimensions are known.
  // applyTransform only sets shared values, so it is safe to call regardless of
  // layout timing (same path as the crop editor). Runs as a layout effect so a
  // recycled cell is already framed in the frame it first paints, instead of
  // showing the photo uncropped for a beat and then snapping into its crop box.
  useLayoutEffect( ( ) => {
    if ( !ready || !initialCrop || framedCrop ) {
      return;
    }
    const zoom = zoomRef.current;
    if ( !zoom ) {
      return;
    }
    const framed = normalizedCropToImageZoomTransform(
      imageWidth,
      imageHeight,
      size,
      size,
      size,
      initialCrop,
    );
    // Clamp the framing so a subject near an edge doesn't shift the image past
    // that edge (matches the crop clamping applied during gestures).
    const limits = computeCropPanTranslateLimits( cropPanContext, framed );
    const clamp = ( v: number, lo: number, hi: number ) => Math.min( Math.max( v, lo ), hi );
    zoom.applyTransform( {
      ...framed,
      translateX: clamp( framed.translateX, limits.minTotalTranslateX, limits.maxTotalTranslateX ),
      translateY: clamp( framed.translateY, limits.minTotalTranslateY, limits.maxTotalTranslateY ),
    } );
    setFramedCrop( initialCrop );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framedCrop, imageHeight, imageWidth, initialCrop, ready, size] );

  const handleInteractionEnd = useCallback( ( ) => {
    if ( !zoomRef.current || !ready ) {
      return;
    }
    const crop = imageZoomTransformToNormalizedCrop(
      imageWidth,
      imageHeight,
      size,
      size,
      size,
      zoomRef.current.readTransform( ),
    );
    // A tap that selects the photo also ends an interaction; only a gesture
    // that actually moved the crop is a crop the user made.
    if ( framedCrop && cropsMatch( framedCrop, crop ) ) {
      return;
    }
    setFramedCrop( crop );
    onCropChange( crop );
  }, [framedCrop, imageHeight, imageWidth, onCropChange, ready, size] );

  if ( !ready ) {
    return null;
  }

  const painted = loadedUri === fullResolutionUri;
  const framed = Boolean( framedCrop )
    && ( painted || paintedImages.has( fullResolutionUri ?? "" ) );

  return (
    <View style={[styles.overlay, !framed && styles.unframed]}>
      {painted && <View style={styles.backdrop} />}
      <SharedZoomableImage
        ref={zoomRef}
        uri={fullResolutionUri}
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
        // Laid out at the cell's own size, exactly like the crop editor. A
        // source with no explicit width/height decodes at the file's full
        // resolution regardless of how large the view is (the New
        // Architecture's RCTImageManager passes the *source's* size to the
        // decoder, not the view's bounds), so the detail is all there and the
        // zoom transform samples it directly. Laying the photo out oversized to
        // "force" a full decode bought nothing and cost the sharpness it was
        // meant to protect: it made this a 16384px-wide layer, past the point
        // Core Animation will render at full fidelity, which is what left a
        // tightly framed cell looking pixelated.
        renderImage={( ) => (
          <Image
            // A cell that lands on a different photo — every cell below a
            // deleted one, and every cell recycled by scrolling — must not
            // reuse the native view that already painted the previous photo:
            // it keeps that bitmap on screen until the new file decodes, so
            // the crop overlay would frame and show the wrong photo.
            key={fullResolutionUri}
            testID="GroupPhotoCropImage.photo"
            accessibilityIgnoresInvertColors
            fadeDuration={0}
            style={StyleSheet.absoluteFill}
            resizeMode="contain"
            source={{ uri: fullResolutionUri }}
            onLoad={( ) => {
              if ( fullResolutionUri ) paintedImages.add( fullResolutionUri );
              setLoadedUri( fullResolutionUri ?? null );
            }}
            onError={e => logger.warn(
              `overlay image failed to load: ${fullResolutionUri}: `
              + `${e.nativeEvent?.error}`,
            )}
          />
        )}
      />
    </View>
  );
};

export default GroupPhotoCropImage;
