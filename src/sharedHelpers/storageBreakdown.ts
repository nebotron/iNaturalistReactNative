import {
  CachesDirectoryPath,
  DocumentDirectoryPath,
  LibraryDirectoryPath,
  MainBundlePath,
  readDir,
  TemporaryDirectoryPath,
} from "@dr.pogodin/react-native-fs";
import { Platform } from "react-native";
import Config from "react-native-config";
import { directoryBytes } from "sharedHelpers/storageMetrics";

export type StorageCategory =
  | "photos"
  | "sounds"
  | "videos"
  | "usbImports"
  | "audioId"
  | "offlineExplore"
  | "database"
  | "appSettings"
  | "temporaryPhotos"
  | "aiModels"
  | "cache"
  | "app"
  | "other";

export interface StorageBreakdown {
  // Largest first, zero-byte categories left out
  categories: { category: StorageCategory; bytes: number }[];
  totalBytes: number;
}

// Top-level names in Documents, matched by prefix so a Realm's .lock, .note
// and .management siblings land with it
const DOCUMENT_PREFIXES: [string, StorageCategory][] = [
  ["photoUploads", "photos"],
  ["soundUploads", "sounds"],
  ["videoLibrary", "videos"],
  ["usbStaging", "usbImports"],
  ["audioIdClips", "audioId"],
  ["offlineExplore", "offlineExplore"],
  ["db.realm", "database"],
  ["mmkv", "appSettings"],
  ["rotatedOriginalPhotos", "temporaryPhotos"],
  ["galleryPhotos", "temporaryPhotos"],
  ["rollbackPhotos", "temporaryPhotos"],
  ["computerVisionSuggestions", "temporaryPhotos"],
  // Android copies its models out of the APK into Documents; iOS reads them
  // from the app bundle
  ...[
    Config.ANDROID_MODEL_FILE_NAME,
    Config.ANDROID_TAXONOMY_FILE_NAME,
    Config.ANDROID_GEOMODEL_FILE_NAME,
  ].filter( ( name ): name is string => !!name )
    .map( name => [name, "aiModels"] as [string, StorageCategory] ),
];

export const categoryForDocument = ( name: string ): StorageCategory => DOCUMENT_PREFIXES
  .find( ( [prefix] ) => name.startsWith( prefix ) )?.[1] ?? "other";

const entryBytes = async ( entry: { isDirectory: ( ) => boolean; path: string; size: number } ) => (
  entry.isDirectory( )
    ? directoryBytes( entry.path )
    : Number( entry.size ) || 0
);

// Every byte the app keeps on the device, by what it's for. Each root is
// walked once and every top-level entry lands in exactly one category, so the
// categories add up to the total.
const getStorageBreakdown = async ( ): Promise<StorageBreakdown> => {
  const bytes: Partial<Record<StorageCategory, number>> = {};
  const add = ( category: StorageCategory, size: number ) => {
    bytes[category] = ( bytes[category] ?? 0 ) + size;
  };

  const documents = async ( ) => {
    const entries = await readDir( DocumentDirectoryPath ).catch( ( ) => [] );
    await Promise.all( entries.map( async entry => {
      add( categoryForDocument( entry.name ), await entryBytes( entry ) );
    } ) );
  };

  // On Android the temporary directory is the cache directory
  const cacheRoots = [...new Set( [CachesDirectoryPath, TemporaryDirectoryPath] )]
    .filter( Boolean );
  const caches = ( ) => Promise.all( cacheRoots.map( async root => {
    add( "cache", await directoryBytes( root ) );
  } ) );

  // iOS Library holds Caches (counted above) plus preferences and the like
  const library = async ( ) => {
    if ( Platform.OS !== "ios" || !LibraryDirectoryPath ) return;
    const entries = await readDir( LibraryDirectoryPath ).catch( ( ) => [] );
    await Promise.all( entries
      .filter( entry => entry.path !== CachesDirectoryPath && entry.name !== "Caches" )
      .map( async entry => add( "other", await entryBytes( entry ) ) ) );
  };

  const bundle = async ( ) => {
    if ( Platform.OS !== "ios" || !MainBundlePath ) return;
    add( "app", await directoryBytes( MainBundlePath ) );
  };

  await Promise.all( [
    documents( ),
    caches( ),
    library( ),
    bundle( ),
  ] );

  const categories = ( Object.entries( bytes ) as [StorageCategory, number][] )
    .filter( ( [, size] ) => size > 0 )
    .map( ( [category, size] ) => ( { category, bytes: size } ) )
    .sort( ( a, b ) => b.bytes - a.bytes );
  return {
    categories,
    totalBytes: categories.reduce( ( sum, { bytes: size } ) => sum + size, 0 ),
  };
};

export default getStorageBreakdown;
