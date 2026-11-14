import { mkdir, TemporaryDirectoryPath, unlink } from "@dr.pogodin/react-native-fs";
import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import { copyUsbImageToFile } from "sharedHelpers/usbStorage";

// Videos on a USB drive go straight into the Photos library, not the import
// staging folder: staged files are offered to the photo picker as photos, and
// the picker already imports videos from the library (as a GIF plus its
// audio, see videoImportHelpers). PhotoKit can't read a file on the drive
// directly, so each video is copied to a temporary file first, and that copy
// is removed once Photos has its own.

const usbVideoTempPath = `${TemporaryDirectoryPath}/usbVideoImport`;

// The copy off the drive and the save into Photos each read the whole file.
// A camera video can be gigabytes, and a 30s deadline sized for photos would
// time out every one of them, so the deadline grows with the file.
const MIN_VIDEO_TIMEOUT_MS = 60_000;
const VIDEO_BYTES_PER_MS = 5_000; // 5 MB/s, the slow end of a USB card reader

export const usbVideoTimeoutMs = ( fileSize: number | null | undefined ) => Math.max(
  MIN_VIDEO_TIMEOUT_MS,
  Math.round( ( fileSize ?? 0 ) / VIDEO_BYTES_PER_MS ),
);

// Copies one video off the drive and saves it into the Photos library.
export const saveUsbVideoToLibrary = async ( relativePath: string ): Promise<void> => {
  await mkdir( usbVideoTempPath );
  const tempPath = `${usbVideoTempPath}/${relativePath.split( "/" ).pop( )}`;
  try {
    await copyUsbImageToFile( relativePath, tempPath );
    // No album: adding to one needs full library access, and saving alone
    // needs only add-only access.
    await enqueuePhotoLibraryWrite( holdChainUntil => {
      const save = CameraRoll.saveAsset( `file://${tempPath}`, { type: "video" } );
      holdChainUntil( save );
      return save;
    } );
  } finally {
    await unlink( tempPath ).catch( ( ) => undefined );
  }
};
