import { CachesDirectoryPath, mkdir } from "@dr.pogodin/react-native-fs";
import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import { videoLibraryPath } from "appConstants/paths";
import { NativeModules, Platform } from "react-native";
import { log } from "sharedHelpers/logger";
import * as uuid from "uuid";

type PhotoNode = PhotoIdentifier["node"];

const logger = log.extend( "videoImportHelpers" );

// iOS CameraRoll returns "video" (not "video/mp4"); Android returns MIME types.
export const isVideoNode = ( node: PhotoNode ): boolean => Boolean(
  node.type?.startsWith( "video" ),
);

const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    extractAudioFromVideo: ( uri: string, dest: string ) => Promise<string>;
    convertVideoToGif: ( uri: string, dest: string ) => Promise<string>;
  };
};

// Returns the URI to use for the video on each platform.
// On iOS, CameraRoll gives a ph:// URI; on Android a content:// or file:// URI.
function videoUriFromNode( node: PhotoNode ): string {
  if ( Platform.OS === "android" ) {
    return node.image.filepath ?? node.image.uri;
  }
  return node.image.uri; // ph:// on iOS
}

// The device library asset a video came from, in the same ph:// form the photo
// picker and Photo Cleanup use. A GIF is a file the app wrote, so without this
// the video it came from has no device URI attached to it, and removing the GIF
// from Group Photos staged nothing for deletion (see removedGroupPhotoUris.ts).
export function deviceVideoUriFromNode( node: PhotoNode ): string | null {
  if ( Platform.OS === "ios" ) {
    return node.id
      ? `ph://${node.id}`
      : null;
  }
  return node.image.uri ?? null;
}

// PhotoKit is asked for the video with network access allowed, so an asset
// iCloud has offloaded is downloaded first -- and requestAVAssetForVideo has
// no deadline of its own: when that download wedges, the result handler is
// simply never called and the promise never settles. The import cell for the
// video then stays pending for the life of the process, which held up
// everything waiting on the import to finish. Generous enough for a real
// download over a slow connection, and finite.
const VIDEO_EXTRACT_TIMEOUT_MS = 2 * 60 * 1000;

const withTimeout = <T, >( promise: Promise<T>, label: string ): Promise<T> => (
  new Promise<T>( ( resolve, reject ) => {
    const timer = setTimeout(
      ( ) => reject( new Error( `${label} timed out after ${VIDEO_EXTRACT_TIMEOUT_MS}ms` ) ),
      VIDEO_EXTRACT_TIMEOUT_MS,
    );
    promise.then(
      value => {
        clearTimeout( timer );
        resolve( value );
      },
      error => {
        clearTimeout( timer );
        reject( error );
      },
    );
  } )
);

export interface ExtractedVideoMedia {
  gifUri: string | null;
  audioUri: string | null;
}

// Extracts a GIF and audio from a video node, returning their local URIs.
// Either may be null if extraction fails (e.g. no audio track).
export async function extractVideoMedia(
  node: PhotoNode,
): Promise<ExtractedVideoMedia> {
  if ( !ImageCropper ) {
    throw new Error( "ImageCropper native module unavailable" );
  }

  const id = uuid.v4();
  const videoUri = videoUriFromNode( node );

  await mkdir( videoLibraryPath ).catch( () => undefined );
  const audioCache = `${CachesDirectoryPath}/video_audio_${id}.m4a`;
  const gifDest = `${videoLibraryPath}/${id}.gif`;

  // Audio extraction is optional — videos may have no audio track, so only the
  // GIF failing is worth a line: that is the whole of what the import gets out
  // of a video, and losing it silently drops the cell off the grid.
  const [audioUri, gifUri] = await Promise.all( [
    withTimeout(
      ImageCropper.extractAudioFromVideo( videoUri, audioCache ),
      "extractAudioFromVideo",
    ).catch( () => null ),
    withTimeout(
      ImageCropper.convertVideoToGif( videoUri, gifDest ),
      "convertVideoToGif",
    ).catch( error => {
      logger.warn( "Could not make a GIF out of an imported video", error );
      return null;
    } ),
  ] );

  return { gifUri, audioUri };
}
