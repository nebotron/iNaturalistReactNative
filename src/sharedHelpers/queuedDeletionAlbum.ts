import { MMKV } from "react-native-mmkv";
import type Realm from "realm";
import type { RealmObservation } from "realmModels/types";
import { savedNormalizedCrop } from "sharedHelpers/cropPhotoMetadata";
import { recordUploadedDevicePhotoUris } from "sharedHelpers/duplicateUploadedDevicePhotos";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import addPhotosToImportedAlbum, {
  removePhotosFromImportedAlbum,
} from "sharedHelpers/importedPhotoAlbum";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import {
  isRemovedGroupPhotoUri,
  onRemovedGroupPhotoUris,
} from "sharedHelpers/removedGroupPhotoUris";
import {
  readRestoredUris,
  restoredUriFor,
  restoreFavedDevicePhotos,
} from "sharedHelpers/restoreFavedDevicePhotos";
import { trackUiWork } from "sharedHelpers/uiDelayTracker";
import {
  expireUsbStaging,
  libraryUriForDevicePhoto,
  readSavedStagedUris,
  saveFavedStagedPhotos,
  startUsbStagingClocks,
} from "sharedHelpers/usbStaging";
import {
  onCachedFavesChanged,
  readCachedObservation,
} from "sharedHelpers/userObservationsCache";

// Keeps the "Imported to iNaturalist" album holding the photos on unfavorited
// observations, as the user creates, edits, faves and removes photos, instead of
// waiting for them to press a button. Photos on a faved observation are taken
// back out, and put back in Photos if they are missing from it
// (restoreFavedDevicePhotos.ts). Nothing else is removed: Realm holds
// only part of the history, so a photo missing from it isn't evidence it
// should leave the album.
//
// Only what changed is refiled: the observations a Realm write touched or
// whose fave changed, and the photos just removed in Group Photos, the picker
// or the cropper. Each photo's place in the album is remembered, so one already
// where it belongs costs a key read and no write to Photos. Nothing here walks
// every observation or every photo; with tens of thousands of them, doing that
// after each upload and fave held up taps across the app for seconds.

const logger = log.extend( "queuedDeletionAlbum" );

const DEBOUNCE_MS = 2000;
// How often expiring the USB staging folder is worth reading it again
const EXPIRY_INTERVAL_MS = 60 * 60 * 1000;

type Placement = "in" | "out";
// Device photo URI → where the album was last told it belongs
const filed = new MMKV( { id: "queued-deletion-album" } );
// What hasn't been done yet, retried at launch: "photo:<uri>" → its
// placement, for a write to Photos that failed, and "obs:<uuid>" for an
// observation whose faved photos couldn't all be saved to Photos. Kept apart
// from `filed`, so a launch lists only these.
const pending = new MMKV( { id: "queued-deletion-album-pending" } );
const PHOTO_PREFIX = "photo:";
const OBS_PREFIX = "obs:";

let source: { realm: Realm; userId?: number } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const queuedObservations = new Set<string>( );
const queuedPhotos = new Map<string, Placement>( );
// Refiles run one at a time, so one starting while another is saving to Photos
// doesn't find the same photos missing and save them a second time.
let refiling: Promise<void> = Promise.resolve( );
let expiredAt = 0;

type FavoritableObservation = RealmObservation & {
  faves?: ( ) => unknown[];
  votes?: ( { vote_scope?: string | null } | null )[];
};

// Realm's votes can be stale; prefer the shared cache, which is reconciled
// with the server on every open.
const isFaved = ( observation: FavoritableObservation, userId?: number ): boolean => {
  const cached = userId && observation.uuid
    ? readCachedObservation( userId, observation.uuid )
    : undefined;
  if ( cached ) return cached.faved;
  if ( typeof observation.faves === "function" ) {
    return observation.faves( ).length > 0;
  }
  return ( observation.votes ?? [] ).some( vote => vote?.vote_scope === null );
};

// Stored URIs may lack the ph:// that normalizeDevicePhotoUri adds
const storedForms = ( uri: string ) => [uri, uri.replace( /^ph:\/\//, "" )];

// The device photos among these that some faved observation other than
// `except` also holds. One Realm query for the lot, run in Realm's own code.
const heldByOtherFaved = (
  realm: Realm,
  uris: string[],
  except: string,
  userId?: number,
): Set<string> => {
  const held = new Set<string>( );
  if ( uris.length === 0 ) return held;
  const wanted = new Set( uris );
  realm.objects<FavoritableObservation>( "Observation" )
    .filtered(
      "uuid != $0 AND ANY observationPhotos.originalDevicePhotoUri IN $1",
      except,
      uris.flatMap( storedForms ),
    )
    .forEach( observation => {
      if ( !isFaved( observation, userId ) ) return;
      ( observation.observationPhotos ?? [] ).forEach( obsPhoto => {
        const uri = normalizeDevicePhotoUri( obsPhoto.originalDevicePhotoUri );
        if ( uri && wanted.has( uri ) ) held.add( uri );
      } );
    } );
  return held;
};

// Looks up the Photos asset holding a device photo: one saved back after a
// refave, a faved USB import's saved copy, or the photo itself. Both maps are
// read once, when this is called, rather than once per photo.
const libraryUriResolver = ( ) => {
  const restored = readRestoredUris( );
  const saved = readSavedStagedUris( );
  return ( uri: string ) => restoredUriFor( uri, restored )
    ?? libraryUriForDevicePhoto( uri, saved );
};

interface Work {
  placements: Map<string, Placement>;
  favedPhotos: { uri: string; crop?: NormalizedCrop }[];
  favedObservations: Set<string>;
  uploaded: string[];
}

const collect = ( realm: Realm, userId: number | undefined, uuids: string[] ): Work => {
  const work: Work = {
    placements: new Map( queuedPhotos ),
    favedPhotos: [],
    favedObservations: new Set( ),
    uploaded: [],
  };
  queuedPhotos.clear( );
  uuids.forEach( uuid => {
    const observation = realm.objectForPrimaryKey<FavoritableObservation>( "Observation", uuid );
    if ( !observation?.isValid( ) ) return;
    const faved = isFaved( observation, userId );
    const uris: string[] = [];
    ( observation.observationPhotos ?? [] ).forEach( obsPhoto => {
      const uri = normalizeDevicePhotoUri( obsPhoto.originalDevicePhotoUri );
      if ( !uri ) return;
      uris.push( uri );
      if ( obsPhoto._synced_at ) work.uploaded.push( uri );
      if ( faved ) {
        work.favedPhotos.push( {
          uri,
          crop: savedNormalizedCrop( obsPhoto.photo ?? {} ) ?? undefined,
        } );
      }
    } );
    if ( faved ) work.favedObservations.add( uuid );
    // A photo also on a faved observation is protected
    const protectedUris = faved
      ? new Set( uris )
      : heldByOtherFaved( realm, uris, uuid, userId );
    uris.forEach( uri => {
      // A photo the user removed in Group Photos is filed, faved or not
      const placement: Placement = !isRemovedGroupPhotoUri( uri ) && protectedUris.has( uri )
        ? "out"
        : "in";
      // A removed photo asked for directly wins over the same photo here
      if ( work.placements.get( uri ) !== "in" ) work.placements.set( uri, placement );
    } );
  } );
  return work;
};

const writePlacements = async ( placements: Map<string, Placement> ) => {
  const changed = [...placements].filter( ( [uri, placement] ) => (
    filed.getString( uri ) !== placement || pending.contains( `${PHOTO_PREFIX}${uri}` )
  ) );
  if ( changed.length === 0 ) return;
  changed.forEach( ( [uri, placement] ) => pending.set( `${PHOTO_PREFIX}${uri}`, placement ) );
  const libraryUriFor = libraryUriResolver( );
  const toFile = changed.filter( ( [, p] ) => p === "in" ).map( ( [uri] ) => uri );
  const toUnfile = changed.filter( ( [, p] ) => p === "out" ).map( ( [uri] ) => uri );
  const [added, removed] = await enqueuePhotoLibraryWrite( async ( ) => [
    await addPhotosToImportedAlbum( toFile.map( libraryUriFor ) ),
    await removePhotosFromImportedAlbum( toUnfile.map( libraryUriFor ) ),
  ] as const );
  // Left pending on failure, for the next launch
  const done = [
    ...( added
      ? toFile
      : [] ),
    ...( removed
      ? toUnfile
      : [] ),
  ];
  done.forEach( uri => {
    filed.set( uri, placements.get( uri ) as Placement );
    pending.delete( `${PHOTO_PREFIX}${uri}` );
  } );
};

// Faved photos belong in Photos: a staged USB photo is saved there, and one
// missing from it (deleted from the album while unfaved) is saved back.
const saveFavedPhotos = async ( realm: Realm, work: Work ) => {
  if ( work.favedPhotos.length === 0 ) return;
  const staged = await saveFavedStagedPhotos( work.favedPhotos );
  const restored = await restoreFavedDevicePhotos(
    realm,
    work.favedPhotos.map( photo => photo.uri ).filter( uri => !isRemovedGroupPhotoUri( uri ) ),
    libraryUriResolver( ),
  );
  // New assets the photo picker would otherwise offer for import again
  const saved = [...staged.saved, ...restored.saved];
  if ( saved.length > 0 && !realm.isClosed ) recordUploadedDevicePhotoUris( realm, saved );
  work.favedObservations.forEach( uuid => {
    if ( staged.refused || restored.failed ) {
      pending.set( `${OBS_PREFIX}${uuid}`, true );
    } else {
      pending.delete( `${OBS_PREFIX}${uuid}` );
    }
  } );
};

const refileNow = async ( ) => {
  const { realm, userId } = source || {};
  if ( !realm || realm.isClosed ) return;
  const uuids = [...queuedObservations];
  queuedObservations.clear( );
  // Everything up to the first await holds the JS thread
  const startedAt = Date.now( );
  const work = collect( realm, userId, uuids );
  // A staged photo's retention starts when its upload finishes
  startUsbStagingClocks( work.uploaded );
  trackUiWork( "queued_deletion_album_sync", startedAt );
  await writePlacements( work.placements );
  await saveFavedPhotos( realm, work );
};

const refile = async ( ) => {
  try {
    await refileNow( );
  } catch ( error ) {
    logger.error( "Refiling the imported album failed", error );
  }
};

const schedule = ( ) => {
  if ( timer ) clearTimeout( timer );
  timer = setTimeout( ( ) => {
    timer = null;
    refiling = refiling.then( refile );
  }, DEBOUNCE_MS );
};

// Refiles the photos of these observations, soon, along with anything else
// asked for meanwhile
export const requestAlbumRefile = ( uuids: Iterable<string> ) => {
  let any = false;
  [...uuids].forEach( uuid => {
    if ( !uuid ) return;
    queuedObservations.add( uuid );
    any = true;
  } );
  if ( any ) schedule( );
};

// Removed photos are filed, and their staged copies' retention starts
const fileRemovedPhotos = ( uris: string[] ) => {
  uris.forEach( uri => {
    const normalized = normalizeDevicePhotoUri( uri );
    if ( normalized ) queuedPhotos.set( normalized, "in" );
  } );
  startUsbStagingClocks( uris );
  schedule( );
};

// Deletes the staged USB photos whose time is up, at most hourly. A faved one
// is kept until it's saved, and its observation refiled so it gets saved.
export const requestUsbStagingExpiry = ( ) => {
  const { realm, userId } = source || {};
  if ( !realm || realm.isClosed || Date.now( ) - expiredAt < EXPIRY_INTERVAL_MS ) return;
  expiredAt = Date.now( );
  void expireUsbStaging( stagedName => {
    if ( realm.isClosed ) return true;
    let faved = false;
    realm.objects<FavoritableObservation>( "Observation" )
      .filtered(
        "ANY observationPhotos.originalDevicePhotoUri ENDSWITH $0",
        `/usbStaging/${stagedName}`,
      )
      .forEach( observation => {
        if ( !isFaved( observation, userId ) ) return;
        faved = true;
        requestAlbumRefile( [observation.uuid] );
      } );
    return faved;
  } );
};

let unsubscribes: ( ( ) => void )[] = [];

export const setQueuedDeletionAlbumSource = ( realm: Realm | null, userId?: number ) => {
  unsubscribes.forEach( unsubscribe => unsubscribe( ) );
  unsubscribes = [];
  source = realm
    ? { realm, userId }
    : null;
  if ( !realm ) return;
  unsubscribes = [
    onCachedFavesChanged( requestAlbumRefile ),
    onRemovedGroupPhotoUris( fileRemovedPhotos ),
  ];
  // Whatever a previous launch didn't get done
  const retryObservations: string[] = [];
  pending.getAllKeys( ).forEach( key => {
    if ( key.startsWith( OBS_PREFIX ) ) {
      retryObservations.push( key.slice( OBS_PREFIX.length ) );
    } else if ( key.startsWith( PHOTO_PREFIX ) ) {
      const placement = pending.getString( key ) as Placement | undefined;
      if ( placement ) queuedPhotos.set( key.slice( PHOTO_PREFIX.length ), placement );
    }
  } );
  if ( retryObservations.length > 0 || queuedPhotos.size > 0 ) {
    requestAlbumRefile( retryObservations );
    schedule( );
  }
};
