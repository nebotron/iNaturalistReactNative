import { copyFile, exists, mkdir } from "@dr.pogodin/react-native-fs";
import { photoUploadPath } from "appConstants/paths";
import { stripFilePrefix } from "sharedHelpers/ensureLocalImageForCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import * as uuid from "uuid";

export interface CropOriginalStorage {
  cropOriginalLocalFilePath?: string | null;
  cropX?: number | null;
  cropY?: number | null;
  cropW?: number | null;
  cropH?: number | null;
}

export interface GroupedPhotoCropMetadata {
  cropOriginalUri?: string;
  crop?: NormalizedCrop;
}

export function savedNormalizedCrop(
  storage: CropOriginalStorage,
): NormalizedCrop | null {
  const {
    cropX, cropY, cropW, cropH,
  } = storage;
  if (
    cropX == null
    || cropY == null
    || cropW == null
    || cropH == null
  ) {
    return null;
  }

  return {
    x: cropX,
    y: cropY,
    w: cropW,
    h: cropH,
  };
}

export function normalizedCropToStorage(
  crop: NormalizedCrop,
): Pick<CropOriginalStorage, "cropX" | "cropY" | "cropW" | "cropH"> {
  return {
    cropX: crop.x,
    cropY: crop.y,
    cropW: crop.w,
    cropH: crop.h,
  };
}

const toLocalFilePath = ( uri: string ) => {
  const stripped = stripFilePrefix( uri );
  if ( stripped.includes( "photoUploads/" ) ) {
    return stripped.slice( stripped.indexOf( "photoUploads/" ) );
  }
  return stripped;
};

export async function preserveCropOriginalPath(
  sourceUri: string,
  existingOriginalPath?: string | null,
): Promise<string> {
  if ( existingOriginalPath ) {
    const existingAbsolutePath = existingOriginalPath.includes( "photoUploads/" )
      ? `${photoUploadPath}/${existingOriginalPath.split( "photoUploads/" ).pop( )}`
      : stripFilePrefix( existingOriginalPath );
    if ( await exists( existingAbsolutePath ) ) {
      return existingOriginalPath;
    }
  }

  await mkdir( photoUploadPath );
  const sourcePath = stripFilePrefix(
    sourceUri.startsWith( "/" )
      ? `file://${sourceUri}`
      : sourceUri,
  );
  const destPath = `${photoUploadPath}/${uuid.v4()}-crop-original.jpg`;
  await copyFile( sourcePath, destPath );
  return toLocalFilePath( destPath );
}

export function cropOriginalUriFromPath(
  cropOriginalLocalFilePath?: string | null,
): string | null {
  if ( !cropOriginalLocalFilePath ) {
    return null;
  }

  if ( cropOriginalLocalFilePath.startsWith( "file://" ) ) {
    return cropOriginalLocalFilePath;
  }

  if ( cropOriginalLocalFilePath.startsWith( "/" ) ) {
    return `file://${cropOriginalLocalFilePath}`;
  }

  return `file://${photoUploadPath}/${cropOriginalLocalFilePath.split( "photoUploads/" ).pop( )}`;
}
