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
// import screen. Recorded at the moment of removal, independent of whether
// the native device-deletion actually succeeds — iOS 26's PHPhotoLibrary
// confirmation bug can silently no-op it (see promptDeleteOriginalDevicePhotos.ts)
// — so the app can still treat them as "gone": hidden from the photo picker
// (PhotoGallery.tsx), and offered again for cleanup in Delete Unfaved
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
