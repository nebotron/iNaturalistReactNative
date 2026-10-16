import { MMKV } from "react-native-mmkv";
import zustandMMKVBackingStorage from "stores/zustandMMKVBackingStorage";

export const USER_OBSERVATIONS_MMKV_ID = "user-observations";
export const AUDIO_ID_CLIPS_MMKV_ID = "audio-id-clips";
export const AUDIO_ID_HEARD_MMKV_ID = "audio-id-heard";
// Instances holding user data outside the default one, which sign-out clears
// along with it, as it did when this data lived there
const instanceIds = [USER_OBSERVATIONS_MMKV_ID, AUDIO_ID_CLIPS_MMKV_ID, AUDIO_ID_HEARD_MMKV_ID];
export const clearMmkvUserData = ( ) => instanceIds
  .forEach( id => new MMKV( { id } ).clearAll( ) );

// A map kept in its own MMKV instance with one key per record, so changing a
// record writes only that record instead of re-serializing the whole map.
const createMmkvRecordStore = <T>( id: string ) => {
  const store = new MMKV( { id } );
  const put = ( key: string | number, value: T ) => {
    store.set( String( key ), JSON.stringify( value ) );
  };
  return {
    put,
    remove: ( key: string | number ) => store.delete( String( key ) ),
    loadAll: ( ): Record<string, T> => {
      const records: Record<string, T> = {};
      store.getAllKeys( ).forEach( key => {
        const json = store.getString( key );
        try {
          if ( json ) records[key] = JSON.parse( json ) as T;
        } catch {
          store.delete( key );
        }
      } );
      return records;
    },
    // Moves a map persisted as one zustand JSON blob in the default instance
    // (at `legacyKey`, under `field`) into this store, one key per record.
    migrateFrom: ( legacyKey: string, field: string ) => {
      const json = zustandMMKVBackingStorage.getString( legacyKey );
      if ( !json ) return;
      try {
        const records = JSON.parse( json )?.state?.[field] as Record<string, T> | undefined;
        Object.entries( records || {} ).forEach( ( [key, value] ) => put( key, value ) );
      } catch {
        // Unreadable; nothing to keep
      }
      zustandMMKVBackingStorage.delete( legacyKey );
    },
  };
};

export default createMmkvRecordStore;
