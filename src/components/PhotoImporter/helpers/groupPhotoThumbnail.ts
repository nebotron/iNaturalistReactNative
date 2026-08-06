import { PixelRatio } from "react-native";

// The crop box zooms well past the cell's own size, so the image the grid zooms
// into is generated larger than the 1x thumbnail a static cell shows. Capped at
// the upload size, which is all the detail a crop can ever carry.
const ZOOM_THUMBNAIL_SCALE = 2;
const MAX_ZOOM_THUMBNAIL_PIXEL = 2048;
// Subject detection runs on this same thumbnail, and the detector letterboxes
// its input into a 640px square, so anything smaller is only upscaled back.
const MIN_ZOOM_THUMBNAIL_PIXEL = 640;

// Pixel size of the thumbnail a Group Photos cell zooms into and detects its
// subject in. Shared with the preload so it warms the same thumbnail file the
// cell will ask for rather than generating a second one at a different size.
const groupPhotoThumbnailMaxPixel = ( size: number ): number => Math.min(
  Math.max(
    PixelRatio.getPixelSizeForLayoutSize( size || 128 ) * ZOOM_THUMBNAIL_SCALE,
    MIN_ZOOM_THUMBNAIL_PIXEL,
  ),
  MAX_ZOOM_THUMBNAIL_PIXEL,
);

export default groupPhotoThumbnailMaxPixel;
