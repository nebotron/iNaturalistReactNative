import { stat } from "@dr.pogodin/react-native-fs";
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
}

const getStorageMetrics = async ( realmPath?: string | null ): Promise<StorageMetrics> => {
  const realmBytes = realmPath
    ? ( await stat( realmPath ).catch( () => ( { size: 0 } ) ) ).size
    : "NA";
  const [freeDiskBytes, totalDiskBytes] = await Promise.all( [
    DeviceInfo.getFreeDiskStorage( ).catch( ( ) => -1 ),
    DeviceInfo.getTotalDiskCapacity( ).catch( ( ) => -1 ),
  ] );
  return {
    realmDbBytes: realmBytes,
    mmkvBytes: zustandMMKVBackingStorage.size,
    freeDiskBytes,
    totalDiskBytes,
  };
};

export default getStorageMetrics;
