import { CachesDirectoryPath, mkdir } from "@dr.pogodin/react-native-fs";
import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import { videoLibraryPath } from "appConstants/paths";
import { NativeModules, Platform } from "react-native";
import * as uuid from "uuid";

type PhotoNode = PhotoIdentifier["node"];

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

  // Audio extraction is optional — videos may have no audio track.
  const [audioUri, gifUri] = await Promise.all( [
    ImageCropper.extractAudioFromVideo( videoUri, audioCache ).catch( () => null ),
    ImageCropper.convertVideoToGif( videoUri, gifDest ).catch( () => null ),
  ] );

  return { gifUri, audioUri };
}
