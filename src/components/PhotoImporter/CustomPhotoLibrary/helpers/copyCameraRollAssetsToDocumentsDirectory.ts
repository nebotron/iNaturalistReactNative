import {
  copyAssetsFileIOS,
  copyFile,
  mkdir,
} from "@dr.pogodin/react-native-fs";
import { photoLibraryPhotosPath } from "appConstants/paths";
import { Platform } from "react-native";
import type { Asset } from "react-native-image-picker";
import mapWithConcurrency from "sharedHelpers/mapWithConcurrency";

const LIBRARY_COPY_CONCURRENCY = Platform.select( {
  ios: 2,
  android: 4,
} ) ?? 2;

const sanitizeFileToken = ( value: string ) => value.replace( /[^\w.-]+/g, "_" );

const buildDestinationFileName = ( asset: Asset, index: number ): string => {
  const extension = asset.type?.startsWith( "video/" )
    ? "mp4"
    : "jpg";
  const assetId = sanitizeFileToken( asset.id || `asset-${index}` );
  const baseName = asset.fileName
    ? sanitizeFileToken( asset.fileName.replace( /\.[^.]+$/, "" ) )
    : `library-${index}`;

  return `${assetId}-${baseName}.${extension}`;
};

export const copyCameraRollAssetToDocumentsDirectory = async (
  asset: Asset,
  index: number,
): Promise<Asset> => {
  await mkdir( photoLibraryPhotosPath );
  const fileName = buildDestinationFileName( asset, index );
  const destPath = `${photoLibraryPhotosPath}/${fileName}`;

  if ( Platform.OS === "ios" ) {
    const sourceUri = asset.originalPath || asset.uri;
    if ( sourceUri?.match( /^ph:/ ) ) {
      const copiedUri = await copyAssetsFileIOS( sourceUri, destPath, 0, 0 );
      return {
        ...asset,
        uri: copiedUri.startsWith( "file://" )
          ? copiedUri
          : `file://${copiedUri}`,
      };
    }
  }

  const sourceUri = asset.uri;
  if ( !sourceUri ) {
    throw new Error( "No URI available for selected library asset" );
  }

  await copyFile( sourceUri, destPath );

  return {
    ...asset,
    uri: Platform.OS === "ios"
      ? `file://${destPath}`
      : destPath,
  };
};

export const copyCameraRollAssetsToDocumentsDirectory = async (
  assets: Asset[],
): Promise<Asset[]> => mapWithConcurrency(
  assets,
  LIBRARY_COPY_CONCURRENCY,
  ( asset, index ) => copyCameraRollAssetToDocumentsDirectory( asset, index ),
);
