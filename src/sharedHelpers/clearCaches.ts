import {
  CachesDirectoryPath, exists, readDir, TemporaryDirectoryPath,
} from "@dr.pogodin/react-native-fs";
import {
  brightnessAdjustedPath,
  computerVisionPath,
  cropSourcesPath,
  deviceThumbnailsPath,
  photoLibraryPhotosPath,
  photoUploadPath,
  remoteImageCachePath,
  rollbackPhotosPath,
  rotatedOriginalPhotosPath,
  soundUploadPath,
  videoLibraryPath,
} from "appConstants/paths";
import removeAllFilesFromDirectory from "sharedHelpers/removeAllFilesFromDirectory";
import removeSyncedFilesFromDirectory from "sharedHelpers/removeSyncedFilesFromDirectory";
import { unlink } from "sharedHelpers/util";
import useStore from "stores/useStore";

const CROP_CACHE_TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
const REMOTE_IMAGE_CACHE_MAX_BYTES = 500 * 1024 * 1024;
// Anything still in tmp after an hour belongs to work that died with an earlier
// run (e.g. a USB raw copied for a Photos save that never completed).
const TEMP_FILE_TTL_MS = 60 * 60 * 1000;

// TODO replace when Realm classes are properly typed
interface RealmObservation {
  observationPhotos: {
    photo: {
      localFilePath: string;
      cropOriginalLocalFilePath?: string;
    };
  }[];
  observationSounds: {
    sound: {
      file_url: string;
    };
  }[];
}

const clearRotatedOriginalPhotosDirectory = async ( ) => {
  await removeAllFilesFromDirectory( rotatedOriginalPhotosPath );
};

// Photos for in-progress Group Photos work are persisted in the Zustand store
// so grouping survives an app kill, but the underlying image files live on
// disk: the imported copies in photoLibraryPhotosPath, and anything cropped
// during the import (plus the untouched original preserved for re-cropping) in
// photoUploadPath. Collect the file names still referenced by groupedPhotos so
// we don't delete the images out from under saved progress.
const groupedPhotoFileNamesToKeep = ( ): string[] => {
  // The store types groupedPhotos loosely; at runtime each photo is
  // { image: { uri, cropOriginalUri } }, so read it through that shape.
  const groupedPhotos = useStore.getState( ).groupedPhotos as unknown as {
    photos?: { image?: { uri?: string; cropOriginalUri?: string } }[];
  }[];
  const fileNames: string[] = [];
  groupedPhotos?.forEach( group => {
    group?.photos?.forEach( photo => {
      [photo?.image?.uri, photo?.image?.cropOriginalUri].forEach( uri => {
        const fileName = uri?.split( "/" ).pop( );
        if ( fileName ) { fileNames.push( fileName ); }
      } );
    } );
  } );
  return fileNames;
};

const clearUngroupedFiles = async ( dir: string ) => {
  const fileNamesToKeep = new Set( groupedPhotoFileNamesToKeep( ) );
  if ( fileNamesToKeep.size === 0 ) {
    await removeAllFilesFromDirectory( dir );
    return;
  }

  const directoryExists = await exists( dir );
  if ( !directoryExists ) { return; }
  const files = await readDir( dir );
  await Promise.all(
    files
      .filter( file => !fileNamesToKeep.has( file.name ) )
      .map( file => unlink( file.path ) ),
  );
};

const clearGalleryPhotos = ( ) => clearUngroupedFiles( photoLibraryPhotosPath );

// GIFs extracted from imported videos; Photo.new copies them into photoUploads.
const clearVideoLibrary = ( ) => clearUngroupedFiles( videoLibraryPath );

const clearComputerVisionPhotos = async ( ) => {
  // Clears resized images used for inatjs.computervision.score_image
  await removeAllFilesFromDirectory( computerVisionPath );
};

// this hook checks to see which localFilePaths are still needed in photoUploads/
// and only keeps the references to photos which have not yet been uploaded
// clearing this directory helps to keep the app size small

const clearSyncedMediaForUpload = async realm => {
// Clean out photos
  const unsyncedObservationsWithPhotos: RealmObservation[] = realm
    .objects( "Observation" )
    .filtered( "observationPhotos._synced_at == nil" );
  const unsyncedPhotoFileNames = unsyncedObservationsWithPhotos
    .map( observation => observation.observationPhotos.map(
      op => [
        op.photo.localFilePath?.split( "photoUploads/" )?.at( 1 ),
        op.photo.cropOriginalLocalFilePath?.split( "photoUploads/" )?.at( 1 ),
      ],
    ) )
    .flat( 2 )
    .filter( Boolean );
  await removeSyncedFilesFromDirectory(
    photoUploadPath,
    // Group Photos crops live here but aren't in Realm until the import
    // finishes, so nothing above accounts for them: without this a restart
    // partway through cropping an import deletes every crop already made, and
    // the grid comes back with cells that can never load.
    // .filter( Boolean ) ensures this array has no undefined members. IDK
    //  why the TS compiler can't figure that out
    //  eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    unsyncedPhotoFileNames.concat( groupedPhotoFileNamesToKeep( ) ),
  );

  // Clean out sounds
  const unsyncedObservationsWithSounds: RealmObservation[] = realm
    .objects( "Observation" )
    .filtered( "observationSounds._synced_at == nil" );
  const unsyncedSoundFileNames = unsyncedObservationsWithSounds
    .map( observation => observation.observationSounds.map(
      os => os.sound.file_url?.split( "soundUploads/" )?.at( 1 ),
    ) )
    .flat( )
    .filter( Boolean );
  await removeSyncedFilesFromDirectory(
    soundUploadPath,
    // .filter( Boolean ) ensures this array has no undefined members. IDK
    //  why the TS compiler can't figure that out
    //  eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    unsyncedSoundFileNames,
  );
};

const clearRollbackPhotos = async ( ) => {
  await removeAllFilesFromDirectory( rollbackPhotosPath );
};

const clearExpiredFilesByTtl = async (
  dir: string,
  ttlMs = CROP_CACHE_TTL_MS,
  shouldClear: ( name: string ) => boolean = ( ) => true,
  includeDirectories = false,
) => {
  const dirExists = await exists( dir );
  if ( !dirExists ) return;
  const files = await readDir( dir );
  const now = Date.now();
  await Promise.all(
    files
      .filter( f => ( f.isFile( ) || ( includeDirectories && f.isDirectory( ) ) )
        && shouldClear( f.name ) )
      .filter( f => now - new Date( f.mtime ).getTime() > ttlMs )
      .map( f => unlink( f.path ) ),
  );
};

// iOS doesn't reliably purge the app's tmp directory, so orphans there grow
// without bound; at tens of MB per USB raw that reached tens of GB. Folders
// count too: libraries and the system write into tmp subfolders, which only
// files being swept left behind forever. UsbStorage clears its own folders.
const clearExpiredTempFiles = ( ) => clearExpiredFilesByTtl(
  TemporaryDirectoryPath,
  TEMP_FILE_TTL_MS,
  name => !name.startsWith( "usbImport-" ),
  true,
);

// Brightness-adjusted previews (useLiveToneMappedBrightnessUri) and audio
// extracted from imported videos are regenerated or moved on use.
const clearExpiredMediaCaches = async ( ) => {
  await clearExpiredFilesByTtl( brightnessAdjustedPath );
  await clearExpiredFilesByTtl(
    CachesDirectoryPath,
    CROP_CACHE_TTL_MS,
    name => name.startsWith( "video_audio_" ),
  );
};

const clearExpiredCropSources = ( ) => clearExpiredFilesByTtl( cropSourcesPath );

// Device-photo grid thumbnails (see useDeviceImageThumbnail) are pure display
// cache, safe to drop once stale; they regenerate on demand.
const clearExpiredDeviceThumbnails = ( ) => clearExpiredFilesByTtl( deviceThumbnailsPath );

// Nuke is meant to sweep this down to 150MB, but on device it grew from 0.5GB
// to 3.7GB in three days without once shrinking. faster-image builds a new
// pipeline, and so a new DataCache, per image view. Drop the least recently
// written files until it is back under the limit.
const trimRemoteImageCache = async ( ) => {
  if ( !( await exists( remoteImageCachePath ) ) ) return;
  const files = ( await readDir( remoteImageCachePath ) ).filter( f => f.isFile( ) );
  let total = files.reduce( ( sum, f ) => sum + ( Number( f.size ) || 0 ), 0 );
  if ( total <= REMOTE_IMAGE_CACHE_MAX_BYTES ) return;
  const oldestFirst = files.sort(
    ( a, b ) => new Date( a.mtime ).getTime( ) - new Date( b.mtime ).getTime( ),
  );
  const toDelete = oldestFirst.filter( file => {
    if ( total <= REMOTE_IMAGE_CACHE_MAX_BYTES * 0.7 ) return false;
    total -= Number( file.size ) || 0;
    return true;
  } );
  await Promise.all( toDelete.map( file => unlink( file.path ) ) );
};

export {
  clearComputerVisionPhotos,
  clearExpiredCropSources,
  clearExpiredDeviceThumbnails,
  clearExpiredMediaCaches,
  clearExpiredTempFiles,
  clearGalleryPhotos,
  clearRollbackPhotos,
  clearRotatedOriginalPhotosDirectory,
  clearSyncedMediaForUpload,
  clearVideoLibrary,
  trimRemoteImageCache,
};
