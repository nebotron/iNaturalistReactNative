import ImageResizer from "@bam.tech/react-native-image-resizer";
import { unlink } from "@dr.pogodin/react-native-fs";
import { rotatedOriginalPhotosPath } from "appConstants/paths";

export interface ViewDimensions {
  width: number;
  height: number;
}

/**
 * Crops a photo to match the region visible in the camera preview when
 * resizeMode="cover" is used.
 *
 * In cover mode the preview scales to fill the view, clipping whatever
 * portion of the sensor frame does not fit. This function applies the same
 * crop to the captured photo so the final image matches what was visible.
 */
const cropPhotoToViewport = async (
  photoUri: string,
  photoWidth: number,
  photoHeight: number,
  viewWidth: number,
  viewHeight: number,
): Promise<string> => {
  if (
    viewWidth <= 0
    || viewHeight <= 0
    || photoWidth <= 0
    || photoHeight <= 0
  ) {
    return photoUri;
  }

  // Cover mode selects the scale that makes both axes meet or exceed the view.
  const scale = Math.max( viewWidth / photoWidth, viewHeight / photoHeight );

  // Visible region in photo-pixel coordinates.
  const cropWidth = Math.round( viewWidth / scale );
  const cropHeight = Math.round( viewHeight / scale );

  // No crop needed when the photo already fits the view exactly.
  if ( cropWidth >= photoWidth && cropHeight >= photoHeight ) {
    return photoUri;
  }

  // Center the crop.
  const originX = Math.round( ( photoWidth - cropWidth ) / 2 );
  const originY = Math.round( ( photoHeight - cropHeight ) / 2 );

  const croppedImage = await ImageResizer.createResizedImage(
    photoUri,
    cropWidth,
    cropHeight,
    "JPEG",
    100,
    0,
    rotatedOriginalPhotosPath,
    true,
    {
      crop: {
        originX,
        originY,
        width: cropWidth,
        height: cropHeight,
      },
    },
  );

  // Remove the uncropped original now that we have the cropped version.
  try {
    await unlink( photoUri.replace( "file://", "" ) );
  } catch {
    // Non-fatal — the original may already be gone.
  }

  return croppedImage.uri;
};

export default cropPhotoToViewport;
