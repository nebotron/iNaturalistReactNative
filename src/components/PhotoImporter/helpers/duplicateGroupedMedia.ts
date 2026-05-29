import { copyFile, mkdir } from "@dr.pogodin/react-native-fs";
import { photoLibraryPhotosPath, photoUploadPath } from "appConstants/paths";
import { Platform } from "react-native";
import type { Asset } from "react-native-image-picker";
import { stripFilePrefix } from "sharedHelpers/ensureLocalImageForCrop";
import * as uuid from "uuid";

export interface MovedVideoAsset {
  uri: string;
  asset: Asset;
}

export interface GroupedMediaPhotoItem {
  image: Asset & {
    cropOriginalUri?: string;
    crop?: object;
  };
}

export interface GroupedMediaItem {
  photos?: GroupedMediaPhotoItem[];
  videos?: MovedVideoAsset[];
}

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
  let { cropOriginalUri } = photo.image;
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
    const videos = await Promise.all(
      group.videos.map( video => duplicateGroupedVideoItem( video ) ),
    );
    return { videos };
  }

  if ( group.photos?.length ) {
    const photos = await Promise.all(
      group.photos.map( photo => duplicateGroupedPhotoItem( photo ) ),
    );
    return { photos };
  }

  return group;
};

export const duplicateGroupedMediaGroups = async (
  groups: GroupedMediaItem[],
): Promise<GroupedMediaItem[]> => Promise.all(
  groups.map( group => duplicateGroupedMediaGroup( group ) ),
);
