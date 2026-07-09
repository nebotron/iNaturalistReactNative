import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import { videoLibraryPath } from "appConstants/paths";
import { CachesDirectoryPath, mkdir } from "@dr.pogodin/react-native-fs";
import { NativeModules, Platform } from "react-native";
import Observation from "realmModels/Observation";
import type { RealmObservationPojo } from "realmModels/types";
import * as uuid from "uuid";

type PhotoNode = PhotoIdentifier["node"];

export const isVideoNode = ( node: PhotoNode ): boolean =>
  Boolean( node.type?.startsWith( "video/" ) );

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

// Creates two observations from a single video node:
//   1. A sound observation with the extracted audio
//   2. A photo observation with the video converted to a GIF
// Returns both as plain JS objects ready for Realm insertion.
export async function createObservationsFromVideoNode(
  node: PhotoNode,
): Promise<RealmObservationPojo[]> {
  const id = uuid.v4();
  const videoUri = videoUriFromNode( node );

  await mkdir( videoLibraryPath ).catch( () => undefined );
  const audioCache = `${CachesDirectoryPath}/video_audio_${id}.m4a`;
  const gifDest = `${videoLibraryPath}/${id}.gif`;

  const [audioUri, gifUri] = await Promise.all( [
    ImageCropper!.extractAudioFromVideo( videoUri, audioCache ),
    ImageCropper!.convertVideoToGif( videoUri, gifDest ),
  ] );

  const [soundObs, gifObs] = await Promise.all( [
    Observation.createObsWithSoundPath( audioUri ),
    Observation.createObservationWithPhotos( [
      {
        image: {
          uri: gifUri,
          type: "image/gif",
          fileName: `${id}.gif`,
          width: node.image.width,
          height: node.image.height,
          fileSize: undefined,
          id: undefined,
          timestamp: String( node.timestamp ),
        },
      },
    ] ),
  ] );

  return [soundObs, gifObs];
}
