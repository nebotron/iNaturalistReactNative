import {
  copyFile,
  downloadFile,
  read as readFileChunk,
  TemporaryDirectoryPath,
  unlink,
} from "@dr.pogodin/react-native-fs";
import * as Exify from "@lodev09/react-native-exify";
import Photo from "realmModels/Photo";
import { log } from "sharedHelpers/logger";

import parseMakerNote from "./exif/parseMakerNote";

const logger = log.extend( "readPhotoExif" );

// EXIF (including the MakerNote and its embedded thumbnail) lives in the JPEG
// APP1 segment near the start of the file, so reading the first chunk is enough
// and avoids pulling a multi-megabyte original into memory.
const MAX_HEADER_BYTES = 256 * 1024;

export type PhotoMetadata = Record<string, unknown>;

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

// Read the raw header bytes of a file and decode the camera MakerNote (e.g.
// Canon focus/subject distance), which ImageIO does not expose through the
// standard EXIF dictionary that Exify.read returns.
const readMakerNote = async ( fileUri: string ): Promise<PhotoMetadata> => {
  try {
    // "ascii" gives a latin1 string where each char code is one raw byte.
    const binary = await readFileChunk( fileUri, MAX_HEADER_BYTES, 0, "ascii" );
    const bytes = new Uint8Array( binary.length );
    for ( let i = 0; i < binary.length; i += 1 ) {
      bytes[i] = binary.charCodeAt( i ) % 256;
    }
    return parseMakerNote( bytes ) || {};
  } catch ( reason ) {
    logger.error( "Failed to parse MakerNote:", reason );
    return {};
  }
};

// Read the complete metadata for a photo: the standard EXIF tags (via the
// native reader) merged with the decoded MakerNote. Suitable for a
// full-metadata inspector.
const readMetadataFromFile = async (
  fileUri: string,
): Promise<PhotoMetadata | null> => {
  const [exif, makerNote] = await Promise.all( [
    Exify.read( fileUri ).catch( ( reason: unknown ) => {
      logger.error( "Failed to read EXIF:", reason );
      return null;
    } ),
    readMakerNote( fileUri ),
  ] );
  if ( !exif && Object.keys( makerNote ).length === 0 ) return null;
  return { ...exif, ...makerNote };
};

const readPhotoExif = async (
  photo: PhotoLike,
): Promise<PhotoMetadata | null> => {
  const uri = readableUriForPhoto( photo );
  if ( !uri ) return null;

  // Local files can be read in place.
  if ( uri.startsWith( "file://" ) || uri.startsWith( "/" ) ) {
    const normalized = uri.startsWith( "/" )
      ? `file://${uri}`
      : uri;
    return readMetadataFromFile( normalized );
  }

  // Remote photos must be downloaded before their metadata can be read.
  const tempPath = `${TemporaryDirectoryPath}/exif_inspect.jpg`;
  try {
    if ( uri.startsWith( "content://" ) ) {
      await copyFile( uri, tempPath );
    } else {
      await downloadFile( { fromUrl: uri, toFile: tempPath } ).promise;
    }
    return await readMetadataFromFile( `file://${tempPath}` );
  } catch ( reason ) {
    logger.error( "Failed to read metadata from remote photo:", reason );
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
