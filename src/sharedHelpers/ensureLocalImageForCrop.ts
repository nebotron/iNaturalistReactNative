import {
  CachesDirectoryPath, copyAssetsFileIOS, downloadFile, exists, mkdir,
} from "@dr.pogodin/react-native-fs";
import { Platform } from "react-native";
import resizeImage from "sharedHelpers/resizeImage";
import * as uuid from "uuid";

const stripFilePrefix = ( uri: string ) => uri.replace( /^file:\/\//, "" );

// Simple deterministic hash so the same remote URL reuses the same local file
const hashString = ( s: string ): string => {
  let h = 0;
  for ( let i = 0; i < s.length; i++ ) {
    // eslint-disable-next-line no-bitwise
    h = ( Math.imul( 31, h ) + s.charCodeAt( i ) ) | 0;
  }
  return ( h >>> 0 ).toString( 16 );
};

const ensureLocalImageForCrop = async ( uri: string ): Promise<string> => {
  if ( uri.match( /^https?:\/\// ) ) {
    const cacheDir = `${CachesDirectoryPath}/inatCropSources`;
    await mkdir( cacheDir );
    const downloadUrl = uri.replace( /(square|small|medium|original)/i, "large" );
    const destPath = `${cacheDir}/${hashString( downloadUrl )}.jpg`;
    if ( !( await exists( destPath ) ) ) {
      await downloadFile( {
        fromUrl: downloadUrl,
        toFile: destPath,
      } ).promise;
    }
    return `file://${destPath}`;
  }

  // ph:// URIs come in two forms:
  // - ph:///path/to/file  → a file path incorrectly wrapped with ph:// prefix; strip it
  // - ph://LOCALIDENTIFIER → an iOS Photos library asset; export via copyAssetsFileIOS
  if ( uri.startsWith( "ph://" ) ) {
    const afterScheme = uri.slice( "ph://".length );
    if ( afterScheme.startsWith( "/" ) ) {
      return `file://${afterScheme}`;
    }
    if ( Platform.OS === "ios" ) {
      const cacheDir = `${CachesDirectoryPath}/inatCropSources`;
      await mkdir( cacheDir );
      const destPath = `${cacheDir}/${uuid.v4()}.jpg`;
      // 99999 → no upscaling; copyAssetsFileIOS caps at the asset's natural dimensions
      await copyAssetsFileIOS( uri, destPath, 99999, 99999 );
      return `file://${destPath}`;
    }
  }

  // Android content:// URIs cannot be read as file paths by the native crop module.
  if ( Platform.OS === "android" && uri.startsWith( "content://" ) ) {
    const cacheDir = `${CachesDirectoryPath}/inatCropSources`;
    await mkdir( cacheDir );
    return resizeImage( uri, {
      width: 99999,
      outputPath: cacheDir,
      imageOptions: { mode: "contain", onlyScaleDown: true },
    } );
  }

  if ( uri.startsWith( "/" ) ) {
    return `file://${uri}`;
  }

  return uri;
};

// Fire-and-forget: warm the crop cache for a remote photo while the user views it
const prefetchForCrop = ( uri: string ): void => {
  if ( !uri.match( /^https?:\/\// ) ) return;
  ensureLocalImageForCrop( uri ).catch( ( ) => { /* ignore prefetch errors */ } );
};

export default ensureLocalImageForCrop;

export { prefetchForCrop, stripFilePrefix };
