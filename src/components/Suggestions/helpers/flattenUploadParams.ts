import { mkdir } from "@dr.pogodin/react-native-fs";
import { computerVisionPath } from "appConstants/paths";
import { FileUpload } from "inaturalistjs";
import cropImageFile from "sharedHelpers/cropImageFile";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import resizeImage from "sharedHelpers/resizeImage";
import { resolveSubjectDetectionForUri } from "sharedHelpers/useSubjectDetectionForUri";

const outputPath = computerVisionPath;

interface FlattenUploadArgs {
  image: {
    uri: string;
    name: string;
    type: string;
  };
}

// Crop the source image to the subject detector bounding box (or the crop log
// entry if one exists) before scoring, so the computer vision request classifies
// the same subject region shown in the thumbnail. Awaiting the shared detector
// here means only one scoring request is made per photo — the one built from the
// cropped image. The detector only runs for images that aren't the current
// user's own; the user's own photos are scored full-frame unless the user framed
// the subject by hand, which is a request to score that region. Falls back to
// the full image if detection or cropping fails.
const cropToSubject = async ( uri: string, loggedCropOnly: boolean ): Promise<string> => {
  try {
    const detection = await resolveSubjectDetectionForUri( uri, { loggedCropOnly } );
    if ( !detection ) return uri;
    const localUri = await ensureLocalImageForCrop( uri );
    return await cropImageFile(
      localUri,
      detection.crop,
      detection.imageWidth,
      detection.imageHeight,
      outputPath,
    );
  } catch {
    return uri;
  }
};

const flattenUploadParams = async (
  uri: string,
  detectSubject: boolean = false,
): Promise<FlattenUploadArgs> => {
  await mkdir( outputPath );

  const sourceUri = await cropToSubject( uri, !detectSubject );

  const uploadUri = await resizeImage( sourceUri, {
    // this max width/height is the same as the legacy Android app
    // we always want the width/height to be bigger than 299x299
    // and want to preserve the aspect ratio (not crunch the image down into a square)
    // for the best results
    width: 640,
    outputPath,
  } );

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
