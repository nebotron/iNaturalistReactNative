import {
  exists, readDir,
} from "@dr.pogodin/react-native-fs";
import { unlink } from "sharedHelpers/util";
import {
  computerVisionPath,
  cropSourcesPath,
  photoLibraryPhotosPath,
  photoUploadPath,
  rollbackPhotosPath,
  rotatedOriginalPhotosPath,
  soundUploadPath,
} from "appConstants/paths";
import removeAllFilesFromDirectory from "sharedHelpers/removeAllFilesFromDirectory";
import removeSyncedFilesFromDirectory from "sharedHelpers/removeSyncedFilesFromDirectory";

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

const clearGalleryPhotos = async ( ) => {
  await removeAllFilesFromDirectory( photoLibraryPhotosPath );
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
    // .filter( Boolean ) ensures this array has no undefined members. IDK
    //  why the TS compiler can't figure that out
    //  eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    unsyncedPhotoFileNames,
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

const clearExpiredCropSources = async ( ) => {
  const dirExists = await exists( cropSourcesPath );
  if ( !dirExists ) return;
  const files = await readDir( cropSourcesPath );
  const now = Date.now();
  await Promise.all(
    files
      .filter( f => now - new Date( f.mtime ).getTime() > CROP_CACHE_TTL_MS )
      .map( f => unlink( f.path ) ),
  );
};

export {
  clearComputerVisionPhotos,
  clearExpiredCropSources,
  clearGalleryPhotos,
  clearRollbackPhotos,
  clearRotatedOriginalPhotosDirectory,
  clearSyncedMediaForUpload,
};
