import {
  exists, readDir,
} from "@dr.pogodin/react-native-fs";
import {
  computerVisionPath,
  cropSourcesPath,
  deviceThumbnailsPath,
  photoLibraryPhotosPath,
  photoUploadPath,
  rollbackPhotosPath,
  rotatedOriginalPhotosPath,
  soundUploadPath,
} from "appConstants/paths";
import removeAllFilesFromDirectory from "sharedHelpers/removeAllFilesFromDirectory";
import removeSyncedFilesFromDirectory from "sharedHelpers/removeSyncedFilesFromDirectory";
import { unlink } from "sharedHelpers/util";
import useStore from "stores/useStore";

const CROP_CACHE_TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

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

// Gallery photos imported for in-progress Group Photos work are persisted in
// the Zustand store so grouping survives an app kill, but the underlying image
// files live in photoLibraryPhotosPath. Collect the file names still referenced
// by groupedPhotos so we don't delete the images out from under saved progress.
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

const clearGalleryPhotos = async ( ) => {
  const fileNamesToKeep = new Set( groupedPhotoFileNamesToKeep( ) );
  if ( fileNamesToKeep.size === 0 ) {
    await removeAllFilesFromDirectory( photoLibraryPhotosPath );
    return;
  }

  const directoryExists = await exists( photoLibraryPhotosPath );
  if ( !directoryExists ) { return; }
  const files = await readDir( photoLibraryPhotosPath );
  await Promise.all(
    files
      .filter( file => !fileNamesToKeep.has( file.name ) )
      .map( file => unlink( file.path ) ),
  );
};

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
    // An in-progress Group Photos import keeps its files here too: cropping a
    // photo writes the cropped file to photoUploads (see cropImageFile), and
    // preserving the uncropped original writes a second one, both long before
    // there is an observation in Realm to reference them. Without the import's
    // own file names the next launch deleted every cropped photo out from
    // under the grid, leaving cells drawing a placeholder over a file that no
    // longer existed.
    // .filter( Boolean ) ensures this array has no undefined members. IDK
    //  why the TS compiler can't figure that out
    //  eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    [...unsyncedPhotoFileNames, ...groupedPhotoFileNamesToKeep( )],
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

const clearExpiredFilesByTtl = async ( dir: string ) => {
  const dirExists = await exists( dir );
  if ( !dirExists ) return;
  const files = await readDir( dir );
  const now = Date.now();
  await Promise.all(
    files
      .filter( f => now - new Date( f.mtime ).getTime() > CROP_CACHE_TTL_MS )
      .map( f => unlink( f.path ) ),
  );
};

const clearExpiredCropSources = ( ) => clearExpiredFilesByTtl( cropSourcesPath );

// Device-photo grid thumbnails (see useDeviceImageThumbnail) are pure display
// cache, safe to drop once stale; they regenerate on demand.
const clearExpiredDeviceThumbnails = ( ) => clearExpiredFilesByTtl( deviceThumbnailsPath );

export {
  clearComputerVisionPhotos,
  clearExpiredCropSources,
  clearExpiredDeviceThumbnails,
  clearGalleryPhotos,
  clearRollbackPhotos,
  clearRotatedOriginalPhotosDirectory,
  clearSyncedMediaForUpload,
};
