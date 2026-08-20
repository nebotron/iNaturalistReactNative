import type { SharedZoomableImageRef } from "components/MediaViewer/SharedZoomableImage";
import SharedZoomableImage from "components/MediaViewer/SharedZoomableImage";
import groupPhotoThumbnailMaxPixel from "components/PhotoImporter/helpers/groupPhotoThumbnail";
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
import { defaultSquareCrop } from "sharedHelpers/normalizedCropTypes";
import useDeviceImageThumbnail, {
  invalidateDeviceImageThumbnail,
} from "sharedHelpers/useDeviceImageThumbnail";
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
  // painted alongside the framed photo, so the backdrop can never black out a
  // cell whose image hasn't arrived yet.
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.black,
  },
  // Mounted (so the ref exists and the crop can be applied) but not yet
  // showing the crop, which would otherwise flash the whole photo for a frame.
  // Applied to the photo rather than to the view around it: iOS hit-testing
  // skips a view with ~zero alpha, so hiding the whole overlay also took the
  // pinch gesture with it and the cell could not be reframed until the photo
  // had painted.
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

// Files this process asked <Image> to draw and got a decode failure back for.
// A thumbnail generation that produced an unopenable file is cached like any
// other, so every cell that lands on that photo is handed the same dead file:
// the overlay never paints, and since the overlay is what carries both the
// crop box and the pinch gesture, the photo looks like its subject detection
// never returned and its pinch does nothing. Remembering them lets a cell fall
// straight through to an image it can actually draw.
const undecodableUris = new Set<string>( );

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
  // Which uri the image below has actually painted. A cell whose crop and
  // photo are both already cached — every cell recycled by scrolling, and
  // every cell that shifts up when one is deleted — frames itself on its first
  // render, while its image is still decoding. Showing the overlay then is what
  // turned those cells black. Tracked as the uri rather than a flag because the
  // cell swaps sources in place as better files arrive: a bare flag stayed true
  // across the swap, so the backdrop kept covering the cell while the native
  // image view had already dropped the bitmap it painted and was decoding the
  // replacement.
  const [paintedUri, setPaintedUri] = useState<string | null>( null );
  // Dimensions reported by the photo below when it decoded. Subject detection
  // normally supplies these, but it yields nothing at all when it can't measure
  // the file (a photo whose thumbnail failed to generate falls back to its
  // ph:// uri, which Image.getSize can't read) or when the detector throws. The
  // photo is on screen either way, so read them off it rather than leaving the
  // cell with no crop box and no gesture.
  const [decodedSize, setDecodedSize] = useState<{ width: number; height: number } | null>( null );
  const [prevCropSourceUri, setPrevCropSourceUri] = useState( cropSourceUri );
  // Bumped when an image fails to decode, purely to re-render onto the next
  // candidate below (the failures themselves are remembered process-wide).
  const [, countLoadFailure] = useState( 0 );

  // Synchronously reset when a recycled cell lands on a different photo, so its
  // first render never frames the new photo with the previous one's crop.
  if ( prevCropSourceUri !== cropSourceUri ) {
    setPrevCropSourceUri( cropSourceUri );
    setFramedCrop( null );
    setPaintedUri( null );
    setDecodedSize( null );
  }

  // Both are routed through the native thumbnail generator (rather than an
  // <Image> reading cropSourceUri directly) so orientation is baked in: a raw
  // device photo can carry any EXIF orientation, and RN's <Image> doesn't
  // reliably re-apply it, which showed up as this layer rendering rotated 90°.
  //
  // The cell already draws this thumbnail and the import prefetches one for
  // every photo (see preloadGroupPhotoSubjectDetection), so it is normally
  // cached before the cell mounts.
  const thumbnailUri = useDeviceImageThumbnail(
    cropSourceUri,
    groupPhotoThumbnailMaxPixel( size ),
  );
  const fullResolutionUri = useDeviceImageThumbnail(
    cropSourceUri,
    FULL_RESOLUTION_MAX_PIXEL,
  );
  // A size whose generation failed resolves to the original uri rather than to
  // a generated file, so identity with the original is how a fallback is told
  // from a real upgrade. Ranking that fallback first is what turned cells black
  // while scrolling: a RAW original (.CR3) has no thumbnail iOS can build at
  // full resolution, so the full-resolution "result" was the .CR3 path itself,
  // and adopting it swapped the working thumbnail out of the cell's native
  // image view for a file that draws slowly or not at all -- leaving the black
  // backdrop alone over an empty cell on every pass back through the grid.
  const generatedFullResolutionUri = fullResolutionUri === cropSourceUri
    ? undefined
    : fullResolutionUri;
  // Shown as soon as there is anything to show, upgraded in place when the
  // full-resolution file lands. Waiting for that file before mounting anything
  // is what made pinch-to-zoom look dead: it is the most expensive job in the
  // app (a full-resolution re-encode per photo, four at a time, allowed to pull
  // the original down from iCloud), nothing prefetches it, and until it existed
  // the cell carried no gesture at all. Anything that came back undecodable is
  // skipped in favour of the next candidate, ending at the original itself, so
  // one bad generated file can't cost the cell its crop box.
  const displayUri = [generatedFullResolutionUri, thumbnailUri, cropSourceUri].find(
    uri => uri && !undecodableUris.has( uri ),
  );

  // Detection runs on the same thumbnail the preload warms, so a cell that has
  // been walked already has its crop and dimensions in hand. Everything the
  // crop math needs from the photo is its aspect ratio, so the thumbnail's own
  // dimensions are as good as the original's.
  const detection = useThumbnailSubjectDetection(
    cropSourceUri,
    thumbnailUri,
    Boolean( savedCrop ),
  );

  const imageWidth = detection?.imageWidth || decodedSize?.width || 0;
  const imageHeight = detection?.imageHeight || decodedSize?.height || 0;
  // A cached detection can carry a crop from before the user's last gesture, so
  // the crop saved on the photo always wins (same as the crop editor). With no
  // crop from either, fall back to the centered square the cell is already
  // showing: detection failing is no reason for the photo to lose its crop box,
  // which is the only thing carrying the pinch gesture.
  const framable = imageWidth > 0 && imageHeight > 0 && size > 0;
  const initialCrop = savedCrop
    ?? detection?.crop
    ?? ( framable
      ? defaultSquareCrop( imageWidth, imageHeight )
      : null );
  // Mounted as soon as there is a photo to draw, so its onLoad can report the
  // dimensions detection didn't.
  const ready = Boolean( displayUri ) && size > 0;

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
    if ( !framable || !initialCrop || framedCrop ) {
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
  }, [framable, framedCrop, imageHeight, imageWidth, initialCrop, size] );

  const handleInteractionEnd = useCallback( ( ) => {
    if ( !zoomRef.current || !framable ) {
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
  }, [framable, framedCrop, imageHeight, imageWidth, onCropChange, size] );

  if ( !ready ) {
    return null;
  }

  // Only counts while the photo on screen is still the one that painted.
  const painted = Boolean( paintedUri ) && paintedUri === displayUri;
  const framed = Boolean( framedCrop ) && ( painted || paintedImages.has( cropSourceUri ) );
  // Both halves are load-bearing, and each one on its own has shipped a black
  // cell. Without `painted`, framed trusts paintedImages, which only says some
  // earlier cell drew this photo: a recycled cell gets a fresh native image
  // view whose file may no longer be in RN's decoded-image cache, so the
  // backdrop painted over a photo that hadn't arrived. Without `framed`, the
  // backdrop outlives the photo in the other direction -- the photo is hidden
  // whenever framedCrop is null, and a cell that can get no dimensions for its
  // photo (detection yields nothing when the thumbnail failed to generate and
  // the fallback is a ph:// uri, which onLoad and Image.getSize both decline to
  // measure) never frames at all, leaving the backdrop alone on screen forever.
  const backdropVisible = framed && painted;

  return (
    <View style={styles.overlay}>
      {backdropVisible && (
        <View testID="GroupPhotoCropImage.backdrop" style={styles.backdrop} />
      )}
      <SharedZoomableImage
        ref={zoomRef}
        uri={displayUri}
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
            // the crop overlay would frame and show the wrong photo. Keyed on
            // the photo rather than the file so that swapping the thumbnail
            // for the full-resolution original is an upgrade in place, which
            // holds the thumbnail on screen until the original has decoded
            // instead of dropping the cell back to an unframed photo.
            key={cropSourceUri}
            testID="GroupPhotoCropImage.photo"
            accessibilityIgnoresInvertColors
            fadeDuration={0}
            style={[StyleSheet.absoluteFill, !framed && styles.unframed]}
            resizeMode="contain"
            source={{ uri: displayUri }}
            onLoad={e => {
              paintedImages.add( cropSourceUri );
              setPaintedUri( displayUri as string );
              // Optional: a load that reports no source at all would otherwise
              // throw here, after painted was already set -- which is exactly
              // the state that leaves a cell framed by nothing.
              const loaded = e.nativeEvent?.source;
              const width = loaded?.width ?? 0;
              const height = loaded?.height ?? 0;
              if ( width > 0 && height > 0 ) {
                setDecodedSize( prev => (
                  prev?.width === width && prev?.height === height
                    ? prev
                    : { width, height }
                ) );
              }
            }}
            onError={e => {
              const failedUri = displayUri as string;
              undecodableUris.add( failedUri );
              logger.warn(
                `overlay image failed to load for ${cropSourceUri}: ${failedUri}: `
                + `${e.nativeEvent?.error}`,
              );
              // Generated files only: the fallback chain ends at the original,
              // and invalidate ignores anything outside the thumbnail cache.
              invalidateDeviceImageThumbnail( failedUri, cropSourceUri );
              countLoadFailure( count => count + 1 );
            }}
          />
        )}
      />
    </View>
  );
};

export default GroupPhotoCropImage;
