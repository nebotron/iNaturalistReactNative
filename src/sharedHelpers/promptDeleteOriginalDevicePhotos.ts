import { Platform } from "react-native";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import addPhotosToImportedAlbum from "sharedHelpers/importedPhotoAlbum";

// This app never deletes photos from the user's photo library. Photos the user
// removed from an observation, or that were imported and are meant to go, are
// only filed into the "Imported to iNaturalist" album (importedPhotoAlbum.ts),
// where the user can select and delete them in Photos themselves.

const filterDevicePhotoUris = ( photoUris: string[] ): string[] => (
  [...new Set(
    photoUris
      .map( uri => normalizeDevicePhotoUri( uri ) )
      .filter( ( uri ): uri is string => !!uri ),
  )].filter( uri => {
    if ( Platform.OS === "ios" ) {
      return uri.startsWith( "ph://" );
    }
    return uri.startsWith( "content://" ) || uri.startsWith( "file://" );
  } )
);

// iOS presents a single system confirmation per Photos-library write. Firing
// a second write (delete OR location update, see applyTrackedLocationToPhotos.ts)
// while one is still in flight can make both hang (iOS won't present a second
// confirmation over the first), and a burst of concurrent writes can also
// spuriously trip each other's timeout under normal I/O load. Route every
// native Photos-library write (not just deletions) through this single chain
// so only one is ever in flight.
let photoLibraryWriteChain: Promise<void> = Promise.resolve( );

const settled = ( promise: Promise<unknown> ): Promise<void> => promise.then(
  ( ) => undefined,
  ( ) => undefined,
);

// Waits for a native write to settle, but not forever: a task whose native call
// never comes back must not poison the chain for the rest of the session.
const heldUntilSettled = ( promise: Promise<unknown>, ms: number ): Promise<void> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race( [
    settled( promise ),
    new Promise<void>( resolve => { timer = setTimeout( resolve, ms ); } ),
  ] ).then( ( ) => { clearTimeout( timer ); } );
};

// Sits above the native deletion watchdog (kInatPendingDeleteWatchdogSeconds in
// ImageCropper.m), so a native call that is merely slow has always settled
// before the chain stops waiting for it.
const CHAIN_HOLD_MS = 170_000;

export const enqueuePhotoLibraryWrite = <T, >(
  task: ( holdChainUntil: ( nativeWrite: Promise<unknown> ) => void ) => Promise<T>,
): Promise<T> => {
  // The native transaction this task opened, when it tells us about one. A task
  // that gives up on its own native call leaves iOS still holding an open
  // performChanges, and opening a second one behind it is what wedges
  // photolibraryd — the whole point of this chain. So the chain waits on the
  // transaction, not on our patience with it.
  let nativeWrite: Promise<unknown> | undefined;
  const run = photoLibraryWriteChain.then(
    ( ) => task( write => { nativeWrite = write; } ),
  );
  // Keep the chain alive even if this write rejects, so later writes still fire.
  photoLibraryWriteChain = settled( run ).then( ( ) => (
    nativeWrite
      ? heldUntilSettled( nativeWrite, CHAIN_HOLD_MS )
      : undefined
  ) );
  return run;
};

// Files the photos meant for deletion into the album. Never deletes anything.
export const fileOriginalDevicePhotosForDeletion = (
  photoUris: string[],
): Promise<void> => {
  const uris = filterDevicePhotoUris( photoUris );
  if ( uris.length === 0 ) return Promise.resolve( );
  return enqueuePhotoLibraryWrite( async holdChainUntil => {
    const filing = addPhotosToImportedAlbum( uris );
    holdChainUntil( filing );
    await filing;
  } );
};

// Files the imported originals into the album for the user to delete, then
// lets the caller move on. Filing asks the user for nothing, so there is no
// reason to hold them on this screen while it runs.
const promptDeleteOriginalDevicePhotos = (
  photoUris: string[],
  onComplete: () => void,
) => {
  void fileOriginalDevicePhotosForDeletion( photoUris );
  onComplete( );
};

export default promptDeleteOriginalDevicePhotos;
