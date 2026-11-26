import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import { Pressable, View } from "components/styledComponents";
import type { ReactNode } from "react";
import React, { useCallback, useState } from "react";
import type { ViewStyle } from "react-native";
import { PixelRatio } from "react-native";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import useDeviceImageThumbnail, {
  invalidateDeviceImageThumbnail,
  isGeneratedThumbnailUri,
} from "sharedHelpers/useDeviceImageThumbnail";

const logger = log.extend( "DevicePhotoImage" );

interface Props {
  // Device photo library uri (ph:// on iOS) or a local file:// path
  uri?: string;
  // Laid-out width of the cell, used to size the generated thumbnail
  cellWidth: number;
  // Overrides the thumbnail size derived from cellWidth, so a grid that
  // prefetches its photos at a particular size (Group Photos) draws the same
  // thumbnail file it warmed instead of generating a second one.
  thumbnailMaxPixel?: number;
  // Shrinks non-square photos to fit the cell instead of cropping to fill it
  fitImage?: boolean;
  style?: ViewStyle;
  selectable?: boolean;
  selected?: boolean;
  obsPhotosCount?: number;
  onPress?: ( ) => void;
  accessibilityLabel?: string;
  testID?: string;
  // Badges and overlays, absolutely positioned over the image
  children?: ReactNode;
  // Makes the cell pinchable: it draws zoomSourceUri (the photo's untouched
  // original) framed to zoomCrop, and reports a pinch's framing of it through
  // onZoomCropChange.
  zoomSourceUri?: string;
  zoomCrop?: NormalizedCrop | null;
  onZoomCropChange?: ( crop: NormalizedCrop ) => void;
  // Exposure multiplier drawn over the pinchable original (1 = unchanged)
  zoomBrightness?: number;
}

// A single square device-photo cell, shared by every grid that renders photos
// straight from the device library (the photo picker, Group Photos, the
// unfavorited-photo cleanup screen). Rendering a small cached thumbnail rather
// than decoding the full-resolution original into every cell is what keeps
// those grids scrolling; see useDeviceImageThumbnail for the scheduling.
const DevicePhotoImage = ( {
  uri,
  cellWidth,
  thumbnailMaxPixel,
  fitImage,
  style,
  selectable = false,
  selected = false,
  obsPhotosCount,
  onPress,
  accessibilityLabel,
  testID,
  children,
  zoomSourceUri,
  zoomCrop,
  onZoomCropChange,
  zoomBrightness,
}: Props ) => {
  const zoomable = !!onZoomCropChange && !!zoomSourceUri;
  // What the cell draws. A pinchable cell draws the original, at full
  // resolution rather than as a thumbnail, since the crop it reports is
  // applied to the original.
  const imageUri = zoomable
    ? zoomSourceUri
    : uri;
  const thumbMaxPixel = thumbnailMaxPixel
    ?? PixelRatio.getPixelSizeForLayoutSize( cellWidth || 128 );
  const thumbnailUri = useDeviceImageThumbnail(
    zoomable
      ? undefined
      : imageUri,
    thumbMaxPixel,
  );
  // A thumbnail that won't decode is a file, not a state of the photo: nothing
  // downstream can tell it from a cell still waiting, so the cell sat on the
  // placeholder (the iconic-taxon leaf) or on a black square for as long as
  // that file was cached under the photo's key. Fall back to the original the
  // thumbnail stands for, and throw the bad file away so the next request
  // regenerates it.
  const [showOriginal, setShowOriginal] = useState( false );
  const [prevUri, setPrevUri] = useState( imageUri );
  if ( prevUri !== imageUri ) {
    // Recycled onto a different photo
    setPrevUri( imageUri );
    setShowOriginal( false );
  }

  const displayUri = showOriginal || zoomable
    ? imageUri
    : thumbnailUri;
  const source = displayUri
    ? { uri: displayUri }
    : undefined;

  const handleError = useCallback( ( ) => {
    if ( !displayUri ) return;
    if ( !isGeneratedThumbnailUri( displayUri ) ) {
      // Nothing left to fall back to: the cell stays a black square.
      logger.errorWithExtra( "device_photo_draw_failed", { uri: displayUri } );
      return;
    }
    setShowOriginal( true );
    invalidateDeviceImageThumbnail( displayUri, imageUri ?? displayUri );
  }, [displayUri, imageUri] );

  const image = (
    <View className="relative">
      <ObsImagePreview
        source={source}
        onError={handleError}
        fitImage={fitImage}
        selected={selected}
        selectable={selectable}
        obsPhotosCount={obsPhotosCount}
        hideGradientOverlay
        squareCorners
        style={style}
        zoomCrop={zoomable
          ? zoomCrop
          : undefined}
        onZoomCropChange={zoomable
          ? onZoomCropChange
          : undefined}
        brightness={zoomable
          ? zoomBrightness
          : undefined}
      />
      {children}
    </View>
  );

  if ( !onPress ) {
    return image;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      testID={testID}
    >
      {image}
    </Pressable>
  );
};

export default DevicePhotoImage;
