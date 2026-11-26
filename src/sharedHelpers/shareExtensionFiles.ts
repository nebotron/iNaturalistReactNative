import {
  CachesDirectoryPath,
  copyFile,
  DocumentDirectoryPath,
  exists,
  mkdir,
} from "@dr.pogodin/react-native-fs";
import { photoLibraryPhotosPath } from "appConstants/paths";
import { Platform } from "react-native";
import { fileExtension } from "sharedHelpers/importedFileTypes";
import { log } from "sharedHelpers/logger";
import { unlink } from "sharedHelpers/util";
import type { GroupedPhoto } from "stores/createObservationFlowSlice";
import * as uuid from "uuid";

const logger = log.extend( "shareExtensionFiles" );

interface SharedPhoto {
  image: {
    uri: string;
  };
}

type GroupedPhotoItem = NonNullable<GroupedPhoto["photos"]>[number];

export function isShareExtensionPhotoUri( pathOrUri: string ): boolean {
  if ( !pathOrUri || pathOrUri.match( /^ph:/ ) ) {
    return false;
  }
  if ( pathOrUri.includes( DocumentDirectoryPath ) ) {
    return false;
  }
  return pathOrUri.includes( "Shared/AppGroup" );
}

function pathForFilesystem( pathOrUri: string ): string {
  if ( pathOrUri.match( /^file:\/\// ) ) {
    return pathOrUri.replace( /^file:\/\//, "" );
  }
  return pathOrUri;
}

function fileNameFromUri( pathOrUri: string ): string {
  const path = pathForFilesystem( pathOrUri );
  const pieces = path.split( "/" );
  return pieces[pieces.length - 1];
}

// For iOS share-extension photos only. Duplicated from PhotoLibrary staging (no Android path).
// Copy, exists?, then unlink is more defensive then the plain move in PhotoLibrary but we are
// moving across two different containers (App Group and Main App Documents) so maybe warranted.
async function moveSingleSharePhotoToGallery(
  photo: GroupedPhotoItem,
): Promise<GroupedPhotoItem> {
  if ( Platform.OS !== "ios" ) {
    return photo;
  }

  const { uri } = photo.image;
  if ( !isShareExtensionPhotoUri( uri ) ) {
    return photo;
  }

  await mkdir( photoLibraryPhotosPath );

  const fileName = fileNameFromUri( uri );
  const sourcePath = pathForFilesystem( uri );
  const destPath = `${photoLibraryPhotosPath}/${fileName}`;

  await copyFile( sourcePath, destPath );

  const destExists = await exists( destPath );
  if ( !destExists ) {
    throw new Error( `Share photo staging failed: ${destPath}` );
  }

  try {
    await unlink( sourcePath );
  } catch ( error ) {
    logger.error( "Failed to remove App Group source after staging copy", error );
  }

  return {
    ...photo,
    image: {
      ...photo.image,
      uri: `file://${destPath}`,
    },
  };
}

export async function moveSharedGroupedPhotos(
  groupedPhotos: GroupedPhoto[],
): Promise<GroupedPhoto[]> {
  try {
    return await Promise.all(
      groupedPhotos.map( async group => ( {
        // A sound-only item (a video's audio track) carries no photos
        photos: await Promise.all(
          ( group.photos || [] ).map( photo => moveSingleSharePhotoToGallery( photo ) ),
        ),
      } ) ),
    );
  } catch ( error ) {
    logger.error( `Failed to move share-extension photos to Documents ${error}` );
    throw error;
  }
}

export async function unlinkIfShareExtensionSource( sharedPhoto: SharedPhoto ): Promise<void> {
  const pathOrUri = sharedPhoto.image.uri;
  if ( !isShareExtensionPhotoUri( pathOrUri ) ) {
    return;
  }
  try {
    await unlink( pathForFilesystem( pathOrUri ) );
  } catch ( error ) {
    logger.error( `Failed to unlink share-extension source ${error}` );
  }
}

export async function unlinkIfShareExtensionSources(
  sharedPhotos: SharedPhoto[],
): Promise<void> {
  await Promise.all(
    sharedPhotos.map( sharedPhoto => unlinkIfShareExtensionSource( sharedPhoto ) ),
  );
}

interface SharedFile {
  mimeType: string;
  data: string;
}

// Audio a share can hand us: a Voice Memo (m4a), or whatever another recorder
// app writes. Matched on extension as well as MIME type, since a share of
// several mixed files on Android arrives with one wildcard type for them all.
const AUDIO_EXTENSIONS = new Set( [
  "m4a", "mp3", "wav", "aac", "caf", "aif", "aiff", "flac", "ogg", "oga", "opus", "amr",
] );

export function isSharedAudio( item: SharedFile ): boolean {
  if ( item.mimeType?.toLowerCase( ).startsWith( "audio/" ) ) {
    return true;
  }
  return AUDIO_EXTENSIONS.has( fileExtension( item.data ) );
}

// Uploads are labelled by platform, not by extension (see
// ObservationSound.mapSoundForUpload), so an unknown one just gets m4a.
function sharedAudioExtension( item: SharedFile ): string {
  const extension = fileExtension( item.data );
  return AUDIO_EXTENSIONS.has( extension )
    ? extension
    : "m4a";
}

// Copies a shared sound into the app's caches and returns a file:// uri for
// it, which Sound.new then moves into soundUploads. iOS hands us a file in the
// App Group container (removed once copied, like a shared photo); Android a
// content:// uri that is only readable while the share intent is live and
// that Sound.new would otherwise store as-is.
export async function stageSharedSound( item: SharedFile ): Promise<string> {
  const fileName = `shared_audio_${uuid.v4( )}.${sharedAudioExtension( item )}`;
  const destPath = `${CachesDirectoryPath}/${fileName}`;
  const source = item.data.startsWith( "content://" )
    ? item.data
    : pathForFilesystem( item.data );
  await copyFile( source, destPath );

  if ( isShareExtensionPhotoUri( item.data ) ) {
    try {
      await unlink( source );
    } catch ( error ) {
      logger.error( "Failed to remove App Group source after staging a shared sound", error );
    }
  }

  return `file://${destPath}`;
}
