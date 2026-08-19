import { zustandStorage } from "stores/useStore";

const STORAGE_KEY = "removedGroupPhotoUris";

const load = ( ): string[] => {
  const raw = zustandStorage.getItem( STORAGE_KEY );
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

const save = ( uris: string[] ): void => {
  zustandStorage.setItem( STORAGE_KEY, JSON.stringify( uris ) );
};

// Device photo URIs (ph:// on iOS) the user removed from the Group Photos
// import screen. An import doesn't delete them from the library — that would
// mean a PHPhotoLibrary confirmation per import, which iOS 26 can silently
// wedge (see promptDeleteOriginalDevicePhotos.ts). Instead they're recorded
// here at the moment of removal and treated as "gone": hidden from the photo
// picker (PhotoGallery.tsx), and offered for deletion in Photo Cleanup
// (unfavoritedDevicePhotos.ts).
export const getRemovedGroupPhotoUris = ( ): string[] => load( );

export const addRemovedGroupPhotoUris = ( uris: string[] ): void => {
  if ( uris.length === 0 ) {
    return;
  }
  const existing = new Set( load( ) );
  uris.forEach( uri => existing.add( uri ) );
  save( [...existing] );
};

// Called once a URI is confirmed actually deleted (or is no longer relevant),
// so the stored list doesn't grow unbounded.
export const clearRemovedGroupPhotoUris = ( uris: string[] ): void => {
  if ( uris.length === 0 ) {
    return;
  }
  const toRemove = new Set( uris );
  save( load( ).filter( uri => !toRemove.has( uri ) ) );
};
