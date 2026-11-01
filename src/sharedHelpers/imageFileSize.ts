import { Image as RNImage, NativeModules } from "react-native";
import { isCanonRawUri } from "sharedHelpers/cr3Metadata";

interface ImageCropperModule {
  imageSize?: ( inputPath: string ) => Promise<{ width: number; height: number }>;
}

const getSizeByDecoding = ( uri: string ) => new Promise<{ w: number; h: number } | null>(
  resolve => {
    RNImage.getSize(
      uri,
      ( w, h ) => resolve( { w, h } ),
      ( ) => resolve( null ),
    );
  },
);

// Whether the file's own metadata can be trusted to describe the image a
// decoder will produce from it. ImageIO cannot demosaic a camera raw, so for
// those it hands back the JPEG preview the camera embedded -- an image several
// times smaller than the sensor dimensions the file declares. A crop framed
// against the declared size would then be cropped out of the preview and fall
// outside it.
const declaredSizeIsTheDecodedSize = ( uri: string ) => (
  ( uri.startsWith( "file://" ) || uri.startsWith( "/" ) ) && !isCanonRawUri( uri )
);

// Display dimensions (EXIF orientation applied) of a local image file.
// Image.getSize loads and decodes the entire photo to answer this, which for a
// full-resolution original costs about as much as everything else the crop
// editor's preload does. The native module reads the dimensions out of the
// file's metadata instead. Falls back to a decode for anything it can't read
// that way (a remote uri, a camera raw, or Android, which has no ImageCropper
// module).
const imageFileSize = async ( uri: string ): Promise<{ w: number; h: number } | null> => {
  const { ImageCropper } = NativeModules as { ImageCropper?: ImageCropperModule };
  if ( ImageCropper?.imageSize && declaredSizeIsTheDecodedSize( uri ) ) {
    const size = await ImageCropper.imageSize( uri ).catch( ( ) => null );
    if ( size && size.width > 0 && size.height > 0 ) {
      return { w: size.width, h: size.height };
    }
  }
  return getSizeByDecoding( uri );
};

export default imageFileSize;
