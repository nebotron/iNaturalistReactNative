import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import { Platform } from "react-native";
import type { Asset } from "react-native-image-picker";

import { getOriginalDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";

export const normalizePhotoTimestampMs = ( timestamp: number ): number => (
  timestamp > 1_000_000_000_000
    ? timestamp
    : timestamp * 1000
);

export const isCameraRollVideo = ( photo: PhotoIdentifier ): boolean => (
  photo.node.type?.startsWith( "video" ) === true
  || photo.node.image.playableDuration > 0
);

export const cameraRollPhotoToAsset = ( photo: PhotoIdentifier ): Asset => {
  const { node } = photo;
  const isVideo = isCameraRollVideo( photo );

  return {
    id: node.id,
    uri: node.image.uri,
    fileName: node.image.filename || undefined,
    type: isVideo
      ? "video/mp4"
      : "image/jpeg",
    fileSize: node.image.fileSize ?? undefined,
    width: node.image.width,
    height: node.image.height,
    timestamp: normalizePhotoTimestampMs( node.timestamp ),
    originalPath: Platform.OS === "ios"
      ? `ph://${node.id}`
      : node.image.uri,
  };
};

export const libraryPhotoFromCameraRoll = ( photo: PhotoIdentifier ) => {
  const asset = cameraRollPhotoToAsset( photo );

  return {
    asset,
    deviceUri: getOriginalDevicePhotoUri( asset ),
    id: photo.node.id,
    isVideo: isCameraRollVideo( photo ),
    photo,
    timestampMs: normalizePhotoTimestampMs( photo.node.timestamp ),
  };
};
