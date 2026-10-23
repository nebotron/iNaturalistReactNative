import type Realm from "realm";
import addPhotosToImportedAlbum, {
  removePhotosFromImportedAlbum,
} from "sharedHelpers/importedPhotoAlbum";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import { classifyDevicePhotoUris } from "sharedHelpers/unfavoritedDevicePhotos";
import { readUserObservationsCache } from "sharedHelpers/userObservationsCache";

// Keeps the "Imported to iNaturalist" album holding what Photo Cleanup would
// delete, as the user creates, edits, faves and removes photos, instead of
// waiting for them to press a button. Photos on a faved observation are taken
// back out. Nothing else is removed: Realm holds only part of the history, so
// a photo missing from it isn't evidence it should leave the album.

const DEBOUNCE_MS = 2000;

let source: { realm: Realm; userId?: number } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
// What the album was last brought in line with, so the listener firing on
// every Realm write (uploads, syncs) costs a comparison, not a library write.
let lastSynced = "";

const syncNow = async ( ) => {
  timer = null;
  const { realm, userId } = source || {};
  if ( !realm || realm.isClosed ) return;
  const cache = userId
    ? readUserObservationsCache( userId )
    : undefined;
  const { unfavorited, favorited } = classifyDevicePhotoUris( realm, cache );
  const signature = JSON.stringify( [unfavorited.sort( ), favorited.sort( )] );
  if ( signature === lastSynced ) return;
  lastSynced = signature;
  const ok = await enqueuePhotoLibraryWrite( async ( ) => {
    const added = await addPhotosToImportedAlbum( unfavorited );
    const removed = await removePhotosFromImportedAlbum( favorited );
    return !!added && removed;
  } );
  // Try again on the next change rather than believing a refused write.
  if ( !ok && lastSynced === signature ) lastSynced = "";
};

export const requestQueuedDeletionAlbumSync = ( ) => {
  if ( timer ) clearTimeout( timer );
  timer = setTimeout( ( ) => { void syncNow( ); }, DEBOUNCE_MS );
};

export const setQueuedDeletionAlbumSource = ( realm: Realm | null, userId?: number ) => {
  source = realm
    ? { realm, userId }
    : null;
};
