import { copyFile, mkdir } from "@dr.pogodin/react-native-fs";
import { photoLibraryPhotosPath, photoUploadPath } from "appConstants/paths";
import { Platform } from "react-native";
import { stripFilePrefix } from "sharedHelpers/ensureLocalImageForCrop";
import * as uuid from "uuid";

import type {
  GroupedMediaItem,
  GroupedMediaPhotoItem,
  MovedVideoAsset,
} from "./photoLibraryMediaHelpers";

const outputDirForUri = ( uri: string ) => {
  const path = stripFilePrefix( uri );
  if ( path.includes( "photoUploads/" ) ) {
    return photoUploadPath;
  }
  return photoLibraryPhotosPath;
};

const toCopiedUri = ( destPath: string, sourceUri: string ) => {
  if ( sourceUri.startsWith( "file://" ) || sourceUri.startsWith( "/" ) ) {
    return `file://${destPath}`;
  }
  return Platform.OS === "ios"
    ? `file://${destPath}`
    : destPath;
};

const copyMediaFile = async ( sourceUri: string ): Promise<string> => {
  const outputDir = outputDirForUri( sourceUri );
  await mkdir( outputDir );
  const sourcePath = stripFilePrefix(
    sourceUri.startsWith( "/" )
      ? `file://${sourceUri}`
      : sourceUri,
  );
  const extension = sourcePath.split( "." ).pop( ) || "jpg";
  const destPath = `${outputDir}/${uuid.v4()}.${extension}`;
  await copyFile( sourcePath, destPath );
  return toCopiedUri( destPath, sourceUri );
};

export const duplicateGroupedPhotoItem = async (
  photo: GroupedMediaPhotoItem,
): Promise<GroupedMediaPhotoItem> => {
  const newUri = await copyMediaFile( photo.image.uri );
  let cropOriginalUri = photo.image.cropOriginalUri;
  if ( cropOriginalUri ) {
    cropOriginalUri = await copyMediaFile( cropOriginalUri );
  }

  return {
    ...photo,
    image: {
      ...photo.image,
      uri: newUri,
      ...( cropOriginalUri
        ? { cropOriginalUri }
        : {}
      ),
      ...( photo.image.crop
        ? { crop: { ...photo.image.crop } }
        : {}
      ),
    },
  };
};

export const duplicateGroupedVideoItem = async (
  video: MovedVideoAsset,
): Promise<MovedVideoAsset> => {
  const newUri = await copyMediaFile( video.uri );

  return {
    uri: newUri,
    asset: {
      ...video.asset,
      uri: newUri,
    },
  };
};

export const duplicateGroupedMediaGroup = async (
  group: GroupedMediaItem,
): Promise<GroupedMediaItem> => {
  if ( group.videos?.length ) {
    const videos = [];
    for ( const video of group.videos ) {
      videos.push( await duplicateGroupedVideoItem( video ) );
    }
    return { videos };
  }

  if ( group.photos?.length ) {
    const photos = [];
    for ( const photo of group.photos ) {
      photos.push( await duplicateGroupedPhotoItem( photo ) );
    }
    return { photos };
  }

  return group;
};

export const duplicateGroupedMediaGroups = async (
  groups: GroupedMediaItem[],
): Promise<GroupedMediaItem[]> => {
  const duplicatedGroups = [];
  for ( const group of groups ) {
    duplicatedGroups.push( await duplicateGroupedMediaGroup( group ) );
  }
  return duplicatedGroups;
};
