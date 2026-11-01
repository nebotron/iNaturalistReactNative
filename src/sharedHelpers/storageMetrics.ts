import {
  CachesDirectoryPath,
  DocumentDirectoryPath,
  LibraryDirectoryPath,
  MainBundlePath,
  pathForGroup,
  readDir,
  stat,
  TemporaryDirectoryPath,
} from "@dr.pogodin/react-native-fs";
import { Platform } from "react-native";
import DeviceInfo from "react-native-device-info";
import zustandMMKVBackingStorage from "stores/zustandMMKVBackingStorage";

export interface StorageMetrics {
  realmDbBytes: number | "NA";
  mmkvBytes: number;
  // How much room the device has left, and how much it has in total. Reported
  // because the app's own footprint doesn't predict it: on Aug 6 a USB offload
  // failed 157 files in a row with "there isn't enough space", and the only
  // storage line in the log said 5MB of MMKV and 8MB of Realm — nothing that
  // could name a full phone. -1 when the platform won't say.
  freeDiskBytes: number;
  totalDiskBytes: number;
  // MB per folder of Documents, Caches, tmp and Library, largest first, as JSON: the
  // log's extra takes only primitives. The app grew to 44GB with nothing in the
  // log saying where.
  largestDirsMB: string;
  // MB in all of each root, the app bundle and the App Group container, as
  // JSON, so the folders above can be held against what iOS Settings reports
  totalsMB: string;
  // KB per key of the default MMKV instance, the five largest, as JSON, so a
  // growing mmkvBytes names what is growing
  largestMmkvKeysKB: string;
}

const MIN_REPORTED_BYTES = 50 * 1024 * 1024;

const directoryBytes = async ( path: string ): Promise<number> => {
  const entries = await readDir( path ).catch( ( ) => [] );
  const sizes = await Promise.all( entries.map( entry => ( entry.isDirectory( )
    ? directoryBytes( entry.path )
    : Number( entry.size ) || 0 ) ) );
  return sizes.reduce( ( sum, size ) => sum + size, 0 );
};

const MB = 1024 * 1024;

const largestDirs = async ( ): Promise<{ largestDirsMB: string; totalsMB: string }> => {
  const roots: Record<string, string> = {
    Documents: DocumentDirectoryPath,
    Caches: CachesDirectoryPath,
    tmp: TemporaryDirectoryPath,
    Library: LibraryDirectoryPath,
  };
  const sizes: [string, number][] = [];
  const totals: Record<string, number> = {};
  const extraRoots: Record<string, string> = { Bundle: MainBundlePath };
  if ( Platform.OS === "ios" ) {
    extraRoots.AppGroup = await pathForGroup( "group.org.inaturalist.iNaturalistMobile" )
      .catch( ( ) => "" );
  }
  await Promise.all( Object.entries( extraRoots ).map( async ( [name, root] ) => {
    if ( root ) totals[name] = Math.round( ( await directoryBytes( root ) ) / MB );
  } ) );
  await Promise.all( Object.entries( roots ).map( async ( [rootName, root] ) => {
    const entries = await readDir( root ).catch( ( ) => [] );
    let looseBytes = 0;
    await Promise.all( entries.map( async entry => {
      // Library/Caches is already its own root.
      if ( rootName === "Library" && entry.name === "Caches" ) return;
      if ( entry.isDirectory( ) ) {
        sizes.push( [`${rootName}/${entry.name}`, await directoryBytes( entry.path )] );
      } else {
        looseBytes += Number( entry.size ) || 0;
      }
    } ) );
    sizes.push( [`${rootName}/*files`, looseBytes] );
    totals[rootName] = Math.round( sizes
      .filter( ( [name] ) => name.startsWith( `${rootName}/` ) )
      .reduce( ( sum, [, bytes] ) => sum + bytes, 0 ) / MB );
  } ) );
  return {
    largestDirsMB: JSON.stringify( Object.fromEntries( sizes
      .filter( ( [, bytes] ) => bytes >= MIN_REPORTED_BYTES )
      .sort( ( a, b ) => b[1] - a[1] )
      .map( ( [name, bytes] ) => [name, Math.round( bytes / MB )] ) ) ),
    totalsMB: JSON.stringify( totals ),
  };
};

const largestMmkvKeys = ( ) => JSON.stringify( Object.fromEntries( zustandMMKVBackingStorage
  .getAllKeys( )
  .map( key => [key, zustandMMKVBackingStorage.getString( key )?.length ?? 0] as const )
  .sort( ( a, b ) => b[1] - a[1] )
  .slice( 0, 5 )
  .map( ( [key, length] ) => [key, Math.round( length / 1024 )] ) ) );

const getStorageMetrics = async ( realmPath?: string | null ): Promise<StorageMetrics> => {
  const realmBytes = realmPath
    ? ( await stat( realmPath ).catch( () => ( { size: 0 } ) ) ).size
    : "NA";
  const [freeDiskBytes, totalDiskBytes, { largestDirsMB, totalsMB }] = await Promise.all( [
    DeviceInfo.getFreeDiskStorage( ).catch( ( ) => -1 ),
    DeviceInfo.getTotalDiskCapacity( ).catch( ( ) => -1 ),
    largestDirs( ).catch( error => ( {
      largestDirsMB: `failed: ${error}`, totalsMB: `failed: ${error}`,
    } ) ),
  ] );
  return {
    realmDbBytes: realmBytes,
    mmkvBytes: zustandMMKVBackingStorage.size,
    freeDiskBytes,
    totalDiskBytes,
    largestDirsMB,
    totalsMB,
    largestMmkvKeysKB: largestMmkvKeys( ),
  };
};

export default getStorageMetrics;
