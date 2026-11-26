import { MMKV } from "react-native-mmkv";

const zustandMMKVBackingStorage = new MMKV( );

// Read before anything writes to it: an install that has ever run has keys
// here, a fresh one has none, which is how cloudBackup knows to restore
export const hadDataAtLaunch = zustandMMKVBackingStorage.getAllKeys( ).length > 0;

export default zustandMMKVBackingStorage;
