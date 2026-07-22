import {
  copyFile,
  downloadFile,
  TemporaryDirectoryPath,
  unlink,
} from "@dr.pogodin/react-native-fs";
import type { ExifTags } from "@lodev09/react-native-exify";
import * as Exify from "@lodev09/react-native-exify";
import Photo from "realmModels/Photo";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "readPhotoExif" );

interface PhotoLike {
  localFilePath?: string;
  url?: string;
}

// Resolve the most metadata-rich URI available for a photo. Local originals
// keep their full EXIF; remote iNaturalist photos are largely stripped, but we
// still read the original-size remote copy when that's all we have.
const readableUriForPhoto = ( photo: PhotoLike ): string | null => {
  const localUri = Photo.getLocalPhotoUri( photo?.localFilePath );
  if ( localUri ) return localUri;
  return Photo.displayOriginalPhoto( photo?.url ) || photo?.url || null;
};

// Read the complete EXIF tag set for a photo. On iOS the native reader returns
// every tag present in the file (camera/lens, exposure, GPS, and focus/subject
// distance), not just a mapped subset, so this is suitable for a full-metadata
// inspector.
const readPhotoExif = async ( photo: PhotoLike ): Promise<ExifTags | null> => {
  const uri = readableUriForPhoto( photo );
  if ( !uri ) return null;

  // Local files can be read in place.
  if ( uri.startsWith( "file://" ) || uri.startsWith( "/" ) ) {
    const normalized = uri.startsWith( "/" )
      ? `file://${uri}`
      : uri;
    try {
      return await Exify.read( normalized );
    } catch ( reason ) {
      logger.error( "Failed to read EXIF from local photo:", reason );
      return null;
    }
  }

  // Remote photos must be downloaded before their EXIF can be read.
  const tempPath = `${TemporaryDirectoryPath}/exif_inspect.jpg`;
  try {
    if ( uri.startsWith( "content://" ) ) {
      await copyFile( uri, tempPath );
    } else {
      await downloadFile( { fromUrl: uri, toFile: tempPath } ).promise;
    }
    return await Exify.read( `file://${tempPath}` );
  } catch ( reason ) {
    logger.error( "Failed to read EXIF from remote photo:", reason );
    return null;
  } finally {
    try {
      await unlink( tempPath );
    } catch {
      // Temp file may not exist; ignore
    }
  }
};

export default readPhotoExif;
