import {
  copyAssetsFileIOS, downloadFile, exists, mkdir, stat,
  unlink,
} from "@dr.pogodin/react-native-fs";
import { cropSourcesPath } from "appConstants/paths";
import { Platform } from "react-native";
import resizeImage from "sharedHelpers/resizeImage";

const CROP_CACHE_TTL_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

// djb2 hash → stable hex filename for a given URL
function urlToFilename( url: string ): string {
  let hash = 5381;
  for ( let i = 0; i < url.length; i += 1 ) {
    // eslint-disable-next-line no-bitwise
    hash = ( ( hash << 5 ) + hash ) ^ url.charCodeAt( i );
    // eslint-disable-next-line no-bitwise
    hash >>>= 0; // keep unsigned 32-bit
  }
  return `${hash.toString( 16 )}.jpg`;
}

async function getCachedOrNull( filePath: string ): Promise<string | null> {
  if ( !( await exists( filePath ) ) ) return null;
  const info = await stat( filePath );
  const age = Date.now() - new Date( info.mtime ).getTime();
  if ( age > CROP_CACHE_TTL_MS ) {
    await unlink( filePath );
    return null;
  }
  return `file://${filePath}`;
}

const ensureLocalImageForCrop = async (
  uri: string,
  // "large" is plenty for subject detection, which only needs to locate a
  // bounding box. The crop editor passes "original" so the photo it actually
  // crops -- and saves -- is never downsampled below what was uploaded.
  targetSize: "large" | "original" = "large",
): Promise<string> => {
  if ( uri.match( /^https?:\/\// ) ) {
    await mkdir( cropSourcesPath );
    const downloadUrl = uri.replace( /(square|small|medium|large|original)/i, targetSize );
    const destPath = `${cropSourcesPath}/${urlToFilename( downloadUrl )}`;
    const cached = await getCachedOrNull( destPath );
    if ( cached ) return cached;
    await downloadFile( {
      fromUrl: downloadUrl,
      toFile: destPath,
    } ).promise;
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
      await mkdir( cropSourcesPath );
      const destPath = `${cropSourcesPath}/${urlToFilename( uri )}`;
      const cached = await getCachedOrNull( destPath );
      if ( cached ) return cached;
      // 99999 → no upscaling; copyAssetsFileIOS caps at the asset's natural dimensions
      await copyAssetsFileIOS( uri, destPath, 99999, 99999 );
      return `file://${destPath}`;
    }
  }

  // Android content:// URIs cannot be read as file paths by the native crop module.
  if ( Platform.OS === "android" && uri.startsWith( "content://" ) ) {
    await mkdir( cropSourcesPath );
    const destPath = `${cropSourcesPath}/${urlToFilename( uri )}`;
    const cached = await getCachedOrNull( destPath );
    if ( cached ) return cached;
    return resizeImage( uri, {
      width: 99999,
      outputPath: cropSourcesPath,
      imageOptions: { mode: "contain", onlyScaleDown: true },
    } );
  }

  if ( uri.startsWith( "/" ) ) {
    return `file://${uri}`;
  }

  return uri;
};

export default ensureLocalImageForCrop;
