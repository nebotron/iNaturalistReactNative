import { devicePhotoKey } from "sharedHelpers/usbStaging";
import zustandMMKVBackingStorage from "stores/zustandMMKVBackingStorage";

const STORAGE_KEY = "removedGroupPhotoUris";

const load = ( ): string[] => {
  const raw = zustandMMKVBackingStorage.getString( STORAGE_KEY );
  if ( typeof raw !== "string" ) {
    return [];
  }
  try {
    const parsed = JSON.parse( raw );
    return Array.isArray( parsed )
      ? parsed.filter( ( uri ): uri is string => typeof uri === "string" )
      : [];
  } catch {
    return [];
  }
};

// The list, parsed once and kept: it holds every photo ever removed (15,000 on
// one device), and the deletion album asks about photos one at a time.
let loaded: Set<string> | null = null;
// The same by devicePhotoKey, which the photo picker matches on
let loadedKeys: Set<string> | null = null;
let saving = false;
const removedSet = ( ): Set<string> => {
  loaded ??= new Set( load( ) );
  return loaded;
};
const removedKeys = ( ): Set<string> => {
  loadedKeys ??= new Set( [...removedSet( )].map( devicePhotoKey ) );
  return loadedKeys;
};

// Anything else writing the key (an iCloud restore) makes the kept copy stale
zustandMMKVBackingStorage.addOnValueChangedListener( key => {
  if ( key === STORAGE_KEY && !saving ) {
    loaded = null;
    loadedKeys = null;
  }
} );

const save = ( uris: Set<string> ): void => {
  saving = true;
  try {
    zustandMMKVBackingStorage.set( STORAGE_KEY, JSON.stringify( [...uris] ) );
  } finally {
    saving = false;
  }
};

type RemovedListener = ( uris: string[] ) => void;
const listeners = new Set<RemovedListener>( );

// Told the photos just removed, so the deletion album can file them
export const onRemovedGroupPhotoUris = ( listener: RemovedListener ) => {
  listeners.add( listener );
  return ( ) => { listeners.delete( listener ); };
};

// Device photo URIs (ph:// on iOS) the user removed from the Group Photos
// import screen. An import doesn't delete them from the library — that would
// mean a PHPhotoLibrary confirmation per import, which iOS 26 can silently
// wedge (see promptDeleteOriginalDevicePhotos.ts). Instead they're recorded
// here at the moment of removal and treated as "gone": hidden from the photo
// picker (PhotoGallery.tsx), and filed in the imported album
// (queuedDeletionAlbum.ts).
export const getRemovedGroupPhotoUris = ( ): string[] => [...removedSet( )];

export const isRemovedGroupPhotoUri = ( uri: string ): boolean => removedSet( ).has( uri );

export const isRemovedDevicePhotoKey = ( key: string ): boolean => removedKeys( ).has( key );

export const hasRemovedGroupPhotoUris = ( ): boolean => removedSet( ).size > 0;

export const addRemovedGroupPhotoUris = ( uris: string[] ): void => {
  const existing = removedSet( );
  const added = uris.filter( uri => !existing.has( uri ) );
  if ( added.length === 0 ) {
    return;
  }
  added.forEach( uri => {
    existing.add( uri );
    loadedKeys?.add( devicePhotoKey( uri ) );
  } );
  save( existing );
  listeners.forEach( listener => listener( added ) );
};
