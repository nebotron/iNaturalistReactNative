import { MMKV } from "react-native-mmkv";

// What a finished crop preload left on disk, kept across launches so a photo
// prepared once (in a bulk crop, in Group Photos, or ahead of the picker) is
// never prepared again after the app is killed or restarted. One key per
// photo, by the URI the cropper knows it by. imageCropPreload reads these back
// at launch and drops any whose files are gone or that are too old.
const store = new MMKV( { id: "crop-preloads" } );

export interface PersistedPreload {
  savedAt: number;
  localUri: string;
  displayUri: string;
  size: { w: number; h: number };
  crop: { x: number; y: number; w: number; h: number };
  timing: unknown;
}

const read = ( key: string ): PersistedPreload | null => {
  try {
    const json = store.getString( key );
    return json
      ? JSON.parse( json ) as PersistedPreload
      : null;
  } catch {
    return null;
  }
};

export const readPersistedPreloads = ( ): [string, PersistedPreload][] => store.getAllKeys( )
  .map( key => [key, read( key )] as [string, PersistedPreload | null] )
  .filter( ( entry ): entry is [string, PersistedPreload] => !!entry[1] );

export const writePersistedPreload = ( imageUri: string, preload: PersistedPreload ) => {
  store.set( imageUri, JSON.stringify( preload ) );
};

export const deletePersistedPreload = ( imageUri: string ) => store.delete( imageUri );

export const clearPersistedPreloads = ( ) => store.clearAll( );

// Names of the files the kept preloads use, which the crop-source sweep at
// launch must leave in place.
export const persistedPreloadFileNames = ( ): Set<string> => new Set(
  readPersistedPreloads( ).flatMap( ( [, preload] ) => [preload.localUri, preload.displayUri] )
    .map( uri => uri.split( "/" ).pop( ) ?? "" )
    .filter( Boolean ),
);
