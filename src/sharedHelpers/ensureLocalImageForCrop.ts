import {
  copyAssetsFileIOS, copyFile, downloadFile, exists, mkdir, moveFile, stat,
  unlink,
} from "@dr.pogodin/react-native-fs";
import { cropSourcesPath } from "appConstants/paths";
import { NativeModules, Platform } from "react-native";

// A source is released once its crop is done (releaseCropSource); one never
// cropped is swept an hour after it was last written.
export const CROP_SOURCE_TTL_MS = 60 * 60 * 1000;

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
  if ( age > CROP_SOURCE_TTL_MS ) {
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

interface CurrentVersionExporter {
  exportPHAssetCurrentVersion?: (
    phUri: string,
    destPath: string,
  ) => Promise<{ uri: string; uti: string }>;
}

// The asset's own bytes keep their format, so its file is named for it. Other
// formats (raws, PNGs) are rare enough to keep going through copyAssetsFileIOS.
const EXPORTED_EXTENSIONS: Record<string, string> = {
  "public.jpeg": "jpg",
  "public.heic": "heic",
};

// Exported as the photo's own file (ImageCropper.exportPHAssetCurrentVersion),
// in the version Photos shows. copyAssetsFileIOS, used before, decoded it and
// re-encoded it as a maximum-quality JPEG several times the original's size,
// which made the crop editor one of the app's heaviest disk writers; the
// exact bytes are also strictly better quality than a re-encode of them.
const exportsInFlight = new Map<string, Promise<string>>( );
const exportPhotoLibraryAsset = ( uri: string ): Promise<string> => {
  const inFlight = exportsInFlight.get( uri );
  if ( inFlight ) return inFlight;
  // eslint-disable-next-line no-use-before-define
  const promise = exportPhotoLibraryAssetOnce( uri )
    .finally( ( ) => exportsInFlight.delete( uri ) );
  exportsInFlight.set( uri, promise );
  return promise;
};

const exportPhotoLibraryAssetOnce = async ( uri: string ): Promise<string> => {
  const base = `${cropSourcesPath}/${urlToFilename( uri ).replace( /\.jpg$/, "" )}`;
  const heicPath = `${base}.heic`;
  const jpgPath = `${base}.jpg`;
  const cached = await getCachedOrNull( heicPath ) ?? await getCachedOrNull( jpgPath );
  if ( cached ) return cached;

  const { ImageCropper } = NativeModules as { ImageCropper?: CurrentVersionExporter };
  if ( ImageCropper?.exportPHAssetCurrentVersion ) {
    // Exported first, then moved to the name its type calls for, so a path
    // only ever holds a whole file of the type its extension says
    const tmpPath = `${base}.${Date.now( )}.export.tmp`;
    try {
      const { uti } = await ImageCropper.exportPHAssetCurrentVersion( uri, tmpPath );
      const extension = EXPORTED_EXTENSIONS[uti];
      if ( extension ) {
        const destPath = `${base}.${extension}`;
        await unlink( destPath ).catch( ( ) => {} );
        await moveFile( tmpPath, destPath );
        return `file://${destPath}`;
      }
    } catch {
      // Fall back to copyAssetsFileIOS below
    }
    await unlink( tmpPath ).catch( ( ) => {} );
  }

  // 99999 → no upscaling; copyAssetsFileIOS caps at the asset's natural dimensions
  await writeAtomically( jpgPath, async tmpPath => {
    await copyAssetsFileIOS( uri, tmpPath, 99999, 99999 );
  } );
  return `file://${jpgPath}`;
};

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
  // - ph://LOCALIDENTIFIER → an iOS Photos library asset; export it
  if ( uri.startsWith( "ph://" ) ) {
    const afterScheme = uri.slice( "ph://".length );
    if ( afterScheme.startsWith( "/" ) ) {
      return `file://${afterScheme}`;
    }
    if ( Platform.OS === "ios" ) {
      await mkdir( cropSourcesPath );
      return exportPhotoLibraryAsset( uri );
    }
  }

  // Android content:// URIs cannot be read as file paths by the native crop module.
  if ( Platform.OS === "android" && uri.startsWith( "content://" ) ) {
    await mkdir( cropSourcesPath );
    const destPath = `${cropSourcesPath}/${urlToFilename( uri )}`;
    const cached = await getCachedOrNull( destPath );
    if ( cached ) return cached;
    // The photo's own bytes, copied through the content resolver. Running it
    // through the resizer at full size re-encoded it -- one more lossy JPEG
    // generation before the crop -- and wrote it under a name of the
    // resizer's choosing, so this cache never hit.
    await writeAtomically( destPath, async tmpPath => {
      await copyFile( uri, tmpPath );
    } );
    return `file://${destPath}`;
  }

  if ( uri.startsWith( "/" ) ) {
    return `file://${uri}`;
  }

  return uri;
};

export default ensureLocalImageForCrop;
