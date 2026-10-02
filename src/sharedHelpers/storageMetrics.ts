import {
  CachesDirectoryPath,
  DocumentDirectoryPath,
  readDir,
  stat,
  TemporaryDirectoryPath,
} from "@dr.pogodin/react-native-fs";
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
  // MB per folder of Documents, Caches and tmp, largest first. The app grew to
  // 44GB with nothing in the log saying where.
  largestDirsMB: Record<string, number>;
}

const MIN_REPORTED_BYTES = 50 * 1024 * 1024;

const directoryBytes = async ( path: string ): Promise<number> => {
  const entries = await readDir( path ).catch( ( ) => [] );
  const sizes = await Promise.all( entries.map( entry => ( entry.isDirectory( )
    ? directoryBytes( entry.path )
    : Number( entry.size ) || 0 ) ) );
  return sizes.reduce( ( sum, size ) => sum + size, 0 );
};

const largestDirs = async ( ): Promise<Record<string, number>> => {
  const roots = {
    Documents: DocumentDirectoryPath,
    Caches: CachesDirectoryPath,
    tmp: TemporaryDirectoryPath,
  };
  const sizes: [string, number][] = [];
  await Promise.all( Object.entries( roots ).map( async ( [rootName, root] ) => {
    const entries = await readDir( root ).catch( ( ) => [] );
    let looseBytes = 0;
    await Promise.all( entries.map( async entry => {
      if ( entry.isDirectory( ) ) {
        sizes.push( [`${rootName}/${entry.name}`, await directoryBytes( entry.path )] );
      } else {
        looseBytes += Number( entry.size ) || 0;
      }
    } ) );
    sizes.push( [`${rootName}/*files`, looseBytes] );
  } ) );
  return Object.fromEntries( sizes
    .filter( ( [, bytes] ) => bytes >= MIN_REPORTED_BYTES )
    .sort( ( a, b ) => b[1] - a[1] )
    .map( ( [name, bytes] ) => [name, Math.round( bytes / 1024 / 1024 )] ) );
};

const getStorageMetrics = async ( realmPath?: string | null ): Promise<StorageMetrics> => {
  const realmBytes = realmPath
    ? ( await stat( realmPath ).catch( () => ( { size: 0 } ) ) ).size
    : "NA";
  const [freeDiskBytes, totalDiskBytes, largestDirsMB] = await Promise.all( [
    DeviceInfo.getFreeDiskStorage( ).catch( ( ) => -1 ),
    DeviceInfo.getTotalDiskCapacity( ).catch( ( ) => -1 ),
    largestDirs( ).catch( ( ) => ( {} ) ),
  ] );
  return {
    realmDbBytes: realmBytes,
    mmkvBytes: zustandMMKVBackingStorage.size,
    freeDiskBytes,
    totalDiskBytes,
    largestDirsMB,
  };
};

export default getStorageMetrics;
