import {
  copyAssetsFileIOS, downloadFile, exists, mkdir, moveFile, stat,
  unlink,
} from "@dr.pogodin/react-native-fs";
import { cropSourcesPath } from "appConstants/paths";
import { Platform } from "react-native";
import resizeImage from "sharedHelpers/resizeImage";
import { getTunable } from "sharedHelpers/tunableParams";

const CROP_CACHE_TTL_MS = getTunable( "cropCacheDays" ) * 24 * 60 * 60 * 1000;

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

// Writes land in a temp file and are renamed into place, so destPath only ever
// holds a whole file. Writing straight to it let a concurrent caller (or the
// next launch, after an interrupted copy) find a truncated JPEG, which iOS
// draws with everything below the cut as solid grey -- and the cache kept
// serving it.
const writesInFlight = new Map<string, Promise<void>>( );
function writeAtomically(
  destPath: string,
  write: ( tmpPath: string ) => Promise<void>,
): Promise<void> {
  const inFlight = writesInFlight.get( destPath );
  if ( inFlight ) return inFlight;
  const tmpPath = `${destPath}.${Date.now( )}.tmp`;
  const promise = write( tmpPath )
    .then( ( ) => moveFile( tmpPath, destPath ) )
    .catch( async error => {
      await unlink( tmpPath ).catch( ( ) => {} );
      throw error;
    } )
    .finally( ( ) => writesInFlight.delete( destPath ) );
  writesInFlight.set( destPath, promise );
  return promise;
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
    await writeAtomically( destPath, async tmpPath => {
      const { statusCode } = await downloadFile( {
        fromUrl: downloadUrl,
        toFile: tmpPath,
      } ).promise;
      if ( statusCode < 200 || statusCode >= 300 ) {
        throw new Error( `Download failed with status ${statusCode}` );
      }
    } );
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
      await writeAtomically( destPath, async tmpPath => {
        await copyAssetsFileIOS( uri, tmpPath, 99999, 99999 );
      } );
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
