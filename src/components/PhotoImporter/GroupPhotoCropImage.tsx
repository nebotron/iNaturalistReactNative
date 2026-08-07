import type { SharedZoomableImageRef } from "components/MediaViewer/SharedZoomableImage";
import SharedZoomableImage from "components/MediaViewer/SharedZoomableImage";
import groupPhotoThumbnailMaxPixel from "components/PhotoImporter/helpers/groupPhotoThumbnail";
import React, {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Image, PixelRatio, StyleSheet, View,
} from "react-native";
import { computeCropPanTranslateLimits } from "sharedHelpers/cropPanTranslateLimits";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import {
  normalizedCropToImageZoomTransform,
} from "sharedHelpers/normalizedCropToImageZoomTransform";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import useDeviceImageThumbnail from "sharedHelpers/useDeviceImageThumbnail";
import useThumbnailSubjectDetection from "sharedHelpers/useThumbnailSubjectDetection";
import colors from "styles/tailwindColors";

const MAX_SCALE = 100;
// Crops round-trip through a screen-space transform, so a gesture that only
// tapped (or barely moved) comes back as a crop that differs in the last few
// decimals. Below this it isn't a crop the user made.
const CROP_EPSILON = 0.001;

// Pixels the photo itself is decoded at. Anything the camera captured fits
// inside this (a 12MP photo is 4032 on its long side), so in practice the cell
// draws the photo at its native resolution; the cap is only there so a
// panorama can't decode a bitmap the size of the whole grid.
const FULL_RESOLUTION_MAX_PIXEL = 4096;

const styles = StyleSheet.create( {
  overlay: {
    ...StyleSheet.absoluteFillObject,
    // The photo is drawn contained rather than cover-cropped, so anything the
    // grid's own thumbnail would show through the letterbox is covered.
    backgroundColor: colors.black,
  },
  // Mounted (so the ref exists and the crop can be applied) but not yet
  // showing the crop, which would otherwise flash the whole photo for a frame.
  // Also covers the gap before the photo itself has decoded, so the black
  // backdrop below never paints over an empty cell.
  unframed: {
    opacity: 0,
  },
} );

// Thumbnails this process has already decoded once. A cell recycled onto one of
// them is showing a bitmap the image cache still holds, so it can reveal its
// crop on the first frame rather than waiting out another onLoad. Waiting was
// what made a photo scrolled back to appear uncropped — the black-backed
// overlay stayed hidden and the plain thumbnail showed through underneath.
const paintedThumbnails = new Set<string>( );

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
// transform math. What differs is that a grid cell runs detection on its own
// thumbnail rather than on a full-resolution copy of the original, so a
// screenful of crops lands in about the time the thumbnails take. Single-finger
// panning is disabled so one finger still scrolls the list.
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
  // The thumbnail the image below has actually painted. A cell whose crop and
  // thumbnail are both already cached — every cell recycled by scrolling, and
  // every cell that shifts up when one is deleted — frames itself on its first
  // render, while its image is still decoding. Showing the overlay then is what
  // turned those cells black.
  const [loadedThumbnailUri, setLoadedThumbnailUri] = useState<string | null>( null );
  const [prevCropSourceUri, setPrevCropSourceUri] = useState( cropSourceUri );

  // Synchronously reset when a recycled cell lands on a different photo, so its
  // first render never frames the new photo with the previous one's crop.
  if ( prevCropSourceUri !== cropSourceUri ) {
    setPrevCropSourceUri( cropSourceUri );
    setFramedCrop( null );
  }

  const thumbnailUri = useDeviceImageThumbnail(
    cropSourceUri,
    groupPhotoThumbnailMaxPixel( size ),
  );

  // Detection runs on the thumbnail above rather than on a full-resolution
  // export of the original, which is what a grid cell had to wait for before:
  // exporting a dozen photos out of the library takes seconds, so the cells sat
  // uncropped long after their thumbnails had arrived.
  const detection = useThumbnailSubjectDetection(
    cropSourceUri,
    thumbnailUri,
    Boolean( savedCrop ),
  );

  const imageWidth = detection?.imageWidth ?? 0;
  const imageHeight = detection?.imageHeight ?? 0;
  // A cached detection can carry a crop from before the user's last gesture, so
  // the crop saved on the photo always wins (same as the crop editor).
  const initialCrop = savedCrop ?? detection?.crop ?? null;
  const ready = Boolean( thumbnailUri ) && imageWidth > 0 && imageHeight > 0 && size > 0;

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

  const framed = Boolean( framedCrop )
    && ( loadedThumbnailUri === thumbnailUri || paintedThumbnails.has( thumbnailUri ?? "" ) );

  // React Native decodes an image to the pixel bounds of the view it's drawn
  // in, so a photo laid out at the cell's own size is downsampled to it no
  // matter how much detail the file holds — and the crop box then zooms into
  // that downsample, which is why a tightly framed cell looked soft. Laying the
  // photo out at its own pixel size and scaling that box back down to the cell
  // leaves the decode full-resolution; scaling about the box's center over the
  // same square means the geometry still matches the thumbnail underneath
  // exactly, so the swap is invisible.
  const fullResolutionSize = FULL_RESOLUTION_MAX_PIXEL / PixelRatio.get( );
  const fullResolutionStyle = {
    position: "absolute" as const,
    left: ( size - fullResolutionSize ) / 2,
    top: ( size - fullResolutionSize ) / 2,
    width: fullResolutionSize,
    height: fullResolutionSize,
    transform: [{ scale: size / fullResolutionSize }],
  };

  return (
    <View style={[styles.overlay, !framed && styles.unframed]}>
      <SharedZoomableImage
        ref={zoomRef}
        uri={thumbnailUri}
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
        renderImage={( ) => (
          <>
            {/*
              The thumbnail the detector ran on, kept underneath as the layer
              that paints immediately: it's already generated and warmed by the
              time the cell mounts, while the photo above it still has to be
              read out of the photo library (and pulled back from iCloud, if the
              original was offloaded). Nothing here waits on that — the cell
              shows the thumbnail and sharpens into the photo when it lands.
            */}
            <Image
              testID="GroupPhotoCropImage.photo"
              accessibilityIgnoresInvertColors
              fadeDuration={0}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
              source={{ uri: thumbnailUri }}
              onLoad={( ) => {
                if ( thumbnailUri ) paintedThumbnails.add( thumbnailUri );
                setLoadedThumbnailUri( thumbnailUri ?? null );
              }}
            />
            {framedCrop && (
              <View style={fullResolutionStyle} pointerEvents="none">
                <Image
                  testID="GroupPhotoCropImage.fullResolutionPhoto"
                  accessibilityIgnoresInvertColors
                  fadeDuration={0}
                  style={StyleSheet.absoluteFill}
                  resizeMode="contain"
                  source={{ uri: cropSourceUri }}
                />
              </View>
            )}
          </>
        )}
      />
    </View>
  );
};

export default GroupPhotoCropImage;
