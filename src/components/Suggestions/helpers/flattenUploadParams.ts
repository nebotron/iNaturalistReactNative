import { mkdir } from "@dr.pogodin/react-native-fs";
import { computerVisionPath } from "appConstants/paths";
import { FileUpload } from "inaturalistjs";
import { Image } from "react-native";
import { getAnimalCrop } from "sharedHelpers/animalCropLog";
import cropImageFile from "sharedHelpers/cropImageFile";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import resizeImage from "sharedHelpers/resizeImage";

const outputPath = computerVisionPath;

interface FlattenUploadArgs {
  image: {
    uri: string;
    name: string;
    type: string;
  };
}

const getImageSize = ( uri: string ): Promise<{ w: number; h: number } | null> =>
  new Promise( resolve => {
    Image.getSize(
      uri,
      ( w, h ) => resolve( { w, h } ),
      ( ) => resolve( null ),
    );
  } );

const flattenUploadParams = async (
  uri: string,
): Promise<FlattenUploadArgs> => {
  await mkdir( outputPath );

  let uploadUri: string;
  const crop = getAnimalCrop( uri );

  if ( crop ) {
    try {
      const localUri = await ensureLocalImageForCrop( uri );
      const imageSize = await getImageSize( localUri );
      if ( imageSize ) {
        const croppedUri = await cropImageFile(
          localUri,
          crop,
          imageSize.w,
          imageSize.h,
          outputPath,
        );
        uploadUri = await resizeImage( croppedUri, {
          width: 640,
          outputPath,
        } );
      } else {
        uploadUri = await resizeImage( uri, { width: 640, outputPath } );
      }
    } catch {
      uploadUri = await resizeImage( uri, { width: 640, outputPath } );
    }
  } else {
    uploadUri = await resizeImage( uri, {
      // this max width/height is the same as the legacy Android app
      // we always want the width/height to be bigger than 299x299
      // and want to preserve the aspect ratio (not crunch the image down into a square)
      // for the best results
      width: 640,
      outputPath,
    } );
  }

  const params: FlattenUploadArgs = {
    image: new FileUpload( {
      uri: uploadUri,
      name: "photo.jpeg",
      type: "image/jpeg",
    } ),
  };

  return params;
};

export default flattenUploadParams;
