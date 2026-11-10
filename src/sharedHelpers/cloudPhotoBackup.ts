import { MMKV } from "react-native-mmkv";
import type Realm from "realm";
import type { RealmObservation, RealmObservationPhoto } from "realmModels/types";
import { cloud, hash, wait } from "sharedHelpers/cloudStore";
import { log } from "sharedHelpers/logger";
import { CLOUD_PHOTO_RESTORE_MMKV_ID } from "sharedHelpers/mmkvRecordStore";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";

// What Realm knows about the user's device photos that the API never returns,
// kept in iCloud Drive so a reinstall keeps it: which library photos have
// been imported (UploadedDevicePhotoUri, and each observation photo's
// originalDevicePhotoUri), and each observation photo's camera settings,
// often the only record once the original is deleted. No photo contents.
// Too big for key-value storage at thousands of photos, so it's a document,
// with its hash in key-value storage to say there is one.
//
// Observations come back from the API after a reinstall, sign-in and sync,
// so the photo records wait in MMKV until upsertRemoteObservations
// (restoredDevicePhoto) or applyDocument finds their observation photo.

const logger = log.extend( "cloudPhotoBackup" );

const DOCUMENT = "devicePhotos.json";
export const DOCUMENT_HASH_KEY = "devicePhotos/hash";
// How long a restore keeps trying to download a document iCloud says exists,
// across launches, before backing up over it
const RESTORE_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
const RESTORE_POLL_MS = 30_000;

interface DevicePhotosDocument {
  v: 1;
  // UploadedDevicePhotoUri: uri, uploadedAt in ms
  uploaded: [string, number][];
  // observation photo uuid, originalDevicePhotoUri, cameraInfo
  photos: [string, string | null, string | null][];
}

// Observation photo uuid → [originalDevicePhotoUri, cameraInfo], restored but
// not yet downloaded again. Sign-out clears it with the rest of the user's data.
const pendingStore = new MMKV( { id: CLOUD_PHOTO_RESTORE_MMKV_ID } );
const stateStore = new MMKV( { id: "cloud-photo-backup" } );
// "pending" while a document iCloud has is still to be restored
const STATE_KEY = "state";
const PENDING_SINCE_KEY = "pendingSince";
const WRITTEN_HASH_KEY = "writtenHash";

export const restoredDevicePhoto = ( uuid: string ): Partial<Pick<
  RealmObservationPhoto, "originalDevicePhotoUri" | "cameraInfo"
>> => {
  const json = pendingStore.getString( uuid );
  if ( !json ) return {};
  const [originalDevicePhotoUri, cameraInfo] = JSON.parse( json ) as [string | null, string | null];
  return {
    ...( originalDevicePhotoUri
      ? { originalDevicePhotoUri }
      : {} ),
    ...( cameraInfo
      ? { cameraInfo }
      : {} ),
  };
};

const fill = ( obsPhoto: RealmObservationPhoto ) => {
  const restored = restoredDevicePhoto( obsPhoto.uuid );
  if ( !obsPhoto.originalDevicePhotoUri && restored.originalDevicePhotoUri ) {
    obsPhoto.originalDevicePhotoUri = restored.originalDevicePhotoUri;
  }
  if ( !obsPhoto.cameraInfo && restored.cameraInfo ) {
    obsPhoto.cameraInfo = restored.cameraInfo;
  }
};

export const applyDocument = ( realm: Realm, document: DevicePhotosDocument ) => {
  document.photos.forEach( ( [uuid, uri, cameraInfo] ) => {
    pendingStore.set( uuid, JSON.stringify( [uri, cameraInfo] ) );
  } );
  safeRealmWrite( realm, ( ) => {
    document.uploaded.forEach( ( [uri, uploadedAt] ) => {
      realm.create(
        "UploadedDevicePhotoUri",
        { uri, uploadedAt: new Date( uploadedAt ) },
        "modified",
      );
    } );
    realm.objects<RealmObservation>( "Observation" ).forEach( observation => {
      observation.observationPhotos?.forEach( fill );
    } );
  }, "restoring device photos from iCloud" );
  logger.info( `Restored ${document.uploaded.length} imported photos and `
    + `${document.photos.length} observation photos from iCloud` );
};

// Realm's records plus restored ones still waiting for their observation.
// Those that found it are dropped from the wait.
export const buildDocument = ( realm: Realm ): DevicePhotosDocument => {
  const photos: DevicePhotosDocument["photos"] = [];
  const inRealm = new Set<string>( );
  realm.objects<RealmObservation>( "Observation" ).forEach( observation => {
    observation.observationPhotos?.forEach( obsPhoto => {
      inRealm.add( obsPhoto.uuid );
      if ( obsPhoto.originalDevicePhotoUri || obsPhoto.cameraInfo ) {
        photos.push( [
          obsPhoto.uuid,
          obsPhoto.originalDevicePhotoUri ?? null,
          obsPhoto.cameraInfo ?? null,
        ] );
      }
    } );
  } );
  pendingStore.getAllKeys( ).forEach( uuid => {
    if ( inRealm.has( uuid ) ) {
      pendingStore.delete( uuid );
      return;
    }
    const json = pendingStore.getString( uuid );
    if ( json ) photos.push( [uuid, ...JSON.parse( json ) as [string | null, string | null]] );
  } );
  const uploaded = realm.objects<{ uri: string; uploadedAt: Date }>( "UploadedDevicePhotoUri" )
    .map( ( { uri, uploadedAt } ): [string, number] => [uri, uploadedAt.getTime( )] );
  return { v: 1, uploaded, photos };
};

// Set by Realm listeners, so a backgrounding with nothing new doesn't walk
// every observation
let changed = true;
const listening = new WeakSet<Realm>( );
const listen = ( realm: Realm ) => {
  if ( listening.has( realm ) ) return;
  listening.add( realm );
  const onChange = ( _: unknown, changes: {
    insertions: number[]; deletions: number[]; newModifications: number[];
  } ) => {
    if ( changes.insertions.length + changes.deletions.length
      + changes.newModifications.length > 0 ) changed = true;
  };
  realm.objects( "Observation" ).addListener( onChange );
  realm.objects( "UploadedDevicePhotoUri" ).addListener( onChange );
};

export const backUpDevicePhotos = async ( realm: Realm ) => {
  listen( realm );
  if ( !cloud || !changed || realm.isClosed
    || stateStore.getString( STATE_KEY ) === "pending" ) return;
  changed = false;
  try {
    const document = buildDocument( realm );
    const writtenHash = stateStore.getString( WRITTEN_HASH_KEY );
    // Nothing to keep, and no backup to empty
    if ( !writtenHash && document.uploaded.length + document.photos.length === 0 ) return;
    const json = JSON.stringify( document );
    const documentHash = hash( json );
    if ( writtenHash === documentHash ) return;
    if ( !await cloud.writeDocument( DOCUMENT, json ) ) return;
    await cloud.update( { [DOCUMENT_HASH_KEY]: documentHash }, [] );
    stateStore.set( WRITTEN_HASH_KEY, documentHash );
  } catch ( error ) {
    changed = true;
    throw error;
  }
};

// Called on a fresh install with what key-value storage held: if it says
// there's a document, nothing is backed up until it has been restored
export const markDevicePhotosToRestore = ( values: Record<string, string> ) => {
  if ( values[DOCUMENT_HASH_KEY] ) stateStore.set( STATE_KEY, "pending" );
};

export const restoreDevicePhotos = async ( realm: Realm ) => {
  if ( !cloud || stateStore.getString( STATE_KEY ) !== "pending" ) return;
  const pendingSince = stateStore.getNumber( PENDING_SINCE_KEY ) ?? Date.now( );
  stateStore.set( PENDING_SINCE_KEY, pendingSince );
  while ( Date.now( ) - pendingSince < RESTORE_WAIT_MS ) {
    // eslint-disable-next-line no-await-in-loop
    const { status, contents } = await cloud.readDocument( DOCUMENT );
    if ( status === "unavailable" ) return;
    if ( status === "ok" && contents ) {
      if ( realm.isClosed ) return;
      applyDocument( realm, JSON.parse( contents ) as DevicePhotosDocument );
      stateStore.set( WRITTEN_HASH_KEY, hash( contents ) );
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await wait( RESTORE_POLL_MS );
  }
  stateStore.delete( STATE_KEY );
  stateStore.delete( PENDING_SINCE_KEY );
};
