import type Realm from "realm";
import { recordUploadedDevicePhotoUris } from "sharedHelpers/duplicateUploadedDevicePhotos";
import addPhotosToImportedAlbum, {
  removePhotosFromImportedAlbum,
} from "sharedHelpers/importedPhotoAlbum";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import {
  readRestoredUris,
  restoredUriFor,
  restoreFavedDevicePhotos,
} from "sharedHelpers/restoreFavedDevicePhotos";
import { trackUiWork } from "sharedHelpers/uiDelayTracker";
import classifyDevicePhotoUris from "sharedHelpers/unfavoritedDevicePhotos";
import {
  libraryUriForDevicePhoto,
  readSavedStagedUris,
  sweepUsbStaging,
} from "sharedHelpers/usbStaging";
import { readUserObservationsCache } from "sharedHelpers/userObservationsCache";

// Keeps the "Imported to iNaturalist" album holding the photos on unfavorited
// observations, as the user creates, edits, faves and removes photos, instead of
// waiting for them to press a button. Photos on a faved observation are taken
// back out, and put back in Photos if they are missing from it
// (restoreFavedDevicePhotos.ts). Nothing else is removed: Realm holds
// only part of the history, so a photo missing from it isn't evidence it
// should leave the album.

const DEBOUNCE_MS = 2000;

let source: { realm: Realm; userId?: number } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
// What the album was last brought in line with, so the listener firing on
// every Realm write (uploads, syncs) costs a comparison, not a library write.
let lastSynced = "";
// Restorations run one at a time, so a sync starting while one is saving
// doesn't find the same photos missing and save them a second time.
let restoring: Promise<void> = Promise.resolve( );

// Looks up the Photos asset holding a device photo: one saved back after a
// refave, a faved USB import's saved copy, or the photo itself. Both maps are
// read once, when this is called, and not per photo: a sync looks up every
// device photo ever imported (tens of thousands), and parsing both maps for
// each one held the JS thread, and so every tap, for a second or more after
// each upload, sync and fave.
const libraryUriResolver = ( ) => {
  const restored = readRestoredUris( );
  const saved = readSavedStagedUris( );
  return ( uri: string ) => restoredUriFor( uri, restored )
    ?? libraryUriForDevicePhoto( uri, saved );
};

const syncNow = async ( ) => {
  timer = null;
  const { realm, userId } = source || {};
  if ( !realm || realm.isClosed ) return;
  // Everything up to the first await holds the JS thread
  const startedAt = Date.now( );
  const cache = userId
    ? readUserObservationsCache( userId )
    : undefined;
  const {
    unfavorited, favorited, crops, uploadedOrRemoved,
  } = classifyDevicePhotoUris( realm, cache );
  // Ahead of the early return: expiry depends on the clock, not on a change.
  void sweepUsbStaging( favorited, uploadedOrRemoved, uris => {
    if ( !realm.isClosed ) recordUploadedDevicePhotoUris( realm, uris );
  }, crops );
  // Faved USB imports were saved to Photos as new assets; file those.
  const libraryUriFor = libraryUriResolver( );
  const toFile = unfavorited.map( libraryUriFor ).sort( );
  const toUnfile = favorited.map( libraryUriFor ).sort( );
  const signature = JSON.stringify( [toFile, toUnfile] );
  trackUiWork( "queued_deletion_album_sync", startedAt );
  if ( signature === lastSynced ) return;
  lastSynced = signature;
  const ok = await enqueuePhotoLibraryWrite( async ( ) => {
    const added = await addPhotosToImportedAlbum( toFile );
    const removed = await removePhotosFromImportedAlbum( toUnfile );
    return !!added && removed;
  } );
  let failed = false;
  restoring = restoring.then( async ( ) => {
    // Read again here: an earlier restore may have saved more since
    const restored = await restoreFavedDevicePhotos( realm, favorited, libraryUriResolver( ) );
    ( { failed } = restored );
    // New assets the photo picker would otherwise offer for import again.
    if ( restored.saved.length > 0 && !realm.isClosed ) {
      recordUploadedDevicePhotoUris( realm, restored.saved );
    }
  } ).catch( ( ) => { failed = true; } );
  await restoring;
  // Try again on the next change rather than believing a refused write.
  if ( ( !ok || failed ) && lastSynced === signature ) lastSynced = "";
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
