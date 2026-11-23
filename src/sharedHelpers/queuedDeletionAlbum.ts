import { MMKV } from "react-native-mmkv";
import type Realm from "realm";
import type { RealmObservation } from "realmModels/types";
import { savedNormalizedCrop } from "sharedHelpers/cropPhotoMetadata";
import {
  getDevicePhotoUrisFromObservation,
  recordUploadedDevicePhotoUris,
} from "sharedHelpers/duplicateUploadedDevicePhotos";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import addPhotosToImportedAlbum, {
  removePhotosFromImportedAlbum,
} from "sharedHelpers/importedPhotoAlbum";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import {
  getRemovedGroupPhotoUris,
  onRemovedGroupPhotoUris,
} from "sharedHelpers/removedGroupPhotoUris";
import {
  restoredUriFor,
  restoreFavedDevicePhotos,
} from "sharedHelpers/restoreFavedDevicePhotos";
import {
  devicePhotoKey,
  expireStagedPhotos,
  isUnsavedStagedPhoto,
  libraryUriForDevicePhoto,
  saveFavedStagedPhotos,
  startStagingClocks,
} from "sharedHelpers/usbStaging";

const logger = log.extend( "queuedDeletionAlbum" );

// Keeps the "Imported to iNaturalist" album holding the device photos the user
// is done with, by reacting to what they do rather than recomputing the album:
//
// - a photo imported onto an unfaved observation is filed in it
// - a photo removed in the photo picker, Group Photos or the cropper is filed
// - faving an observation takes its photos out, saves any staged USB photo to
//   Photos, and puts back any photo missing from Photos (restoreFavedDevicePhotos.ts)
// - unfaving an observation files its photos again
//
// Each costs a few reads and writes per photo on the observation that changed,
// whatever the size of the library. This assumes a photo is on at most one
// observation, and that faves only change on this device.
//
// What the album should do is written to a durable outbox before the Photos
// library is touched, and an entry leaves it only once the library took the
// change, so a busy or refused library, or the app being killed, loses nothing:
// the outbox is retried on the next change, launch or return to the app.

const DEBOUNCE_MS = 2000;
// Bumped to rebuild every record from Realm on the next launch.
const BACKFILL_VERSION = 1;
const BACKFILL_KEY = "backfilledVersion";

// Each observation's faved state and device photos as last applied, so a
// change can be told apart from a write that changed nothing the album uses.
// Each device photo's observation and faved state, for the photo's own
// lookups (restoring it, saving it, letting its staged file expire).
const state = new MMKV( { id: "queued-deletion-album" } );
// Device photo key → what the album should do with it. Its own instance, so
// listing what's pending lists nothing else.
const outbox = new MMKV( { id: "queued-deletion-album-outbox" } );

type Want = "file" | "unfile";

interface ObservationRecord {
  faved: boolean;
  uris: string[];
}

interface PhotoRecord {
  uuid?: string;
  faved: boolean;
}

interface OutboxEntry {
  key: string;
  raw: string;
  uri: string;
  want: Want;
}

const observationKey = ( uuid: string ) => `obs/${uuid}`;
const photoKey = ( uri: string ) => `photo/${devicePhotoKey( uri )}`;

const readJson = <T>( store: MMKV, key: string ): T | undefined => {
  const raw = store.getString( key );
  let value: T | undefined;
  try {
    value = raw
      ? JSON.parse( raw )
      : undefined;
  } catch {
    value = undefined;
  }
  return value;
};

let source: { realm: Realm } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const enqueue = ( uri: string, want: Want ) => {
  outbox.set( devicePhotoKey( uri ), JSON.stringify( { uri, want } ) );
};

// RealmObservation's type doesn't surface votes/faves, but both exist at
// runtime (see realmModels/Observation.js), so widen the type here.
export type FavoritableObservation = RealmObservation & {
  faves?: ( ) => unknown[];
  votes?: ( { vote_scope?: string | null } | null )[];
};

// An observation is favorited when it has at least one vote with a null scope.
const isFavorited = ( observation: FavoritableObservation ): boolean => {
  if ( typeof observation.faves === "function" ) {
    return observation.faves( ).length > 0;
  }
  return ( observation.votes ?? [] ).some( vote => vote?.vote_scope === null );
};

// Brings the records and the outbox in line with one observation. Resolves
// whether anything was queued for the album. rebuild: queue every photo, as
// if the observation had never been seen.
const applyObservation = ( observation: FavoritableObservation, rebuild = false ): boolean => {
  const { uuid } = observation;
  if ( !uuid ) return false;
  const faved = isFavorited( observation );
  const uris = getDevicePhotoUrisFromObservation( observation );
  const previous = rebuild
    ? undefined
    : readJson<ObservationRecord>( state, observationKey( uuid ) );
  // A fave or unfave moves every photo; otherwise only the ones just added do.
  const changed = previous?.faved === faved
    ? uris.filter( uri => !previous.uris.includes( uri ) )
    : uris;
  changed.forEach( uri => {
    state.set( photoKey( uri ), JSON.stringify( { uuid, faved } ) );
    enqueue( uri, faved
      ? "unfile"
      : "file" );
  } );
  if (
    !previous
    || previous.faved !== faved
    || previous.uris.length !== uris.length
    || changed.length > 0
  ) {
    state.set( observationKey( uuid ), JSON.stringify( { faved, uris } ) );
  }
  // A staged photo's retention clock starts once its upload finishes.
  const synced = ( observation.observationPhotos ?? [] )
    .filter( obsPhoto => !!obsPhoto._synced_at )
    .map( obsPhoto => normalizeDevicePhotoUri( obsPhoto.originalDevicePhotoUri ) )
    .filter( ( uri ): uri is string => !!uri );
  startStagingClocks( synced );
  return changed.length > 0;
};

// Removed photos are filed, and start their staging clock, as soon as they're
// removed. The screens that remove them flush the album once they close.
onRemovedGroupPhotoUris( uris => {
  uris.forEach( uri => {
    state.set( photoKey( uri ), JSON.stringify( { faved: false } ) );
    enqueue( uri, "file" );
  } );
  startStagingClocks( uris );
} );

// The Photos asset holding a device photo: one saved back after a refave, a
// faved USB import's saved copy, or the photo itself.
const libraryUriFor = ( uri: string ) => restoredUriFor( uri ) ?? libraryUriForDevicePhoto( uri );

// The observation photo carrying a device photo, found through its record.
const obsPhotoFor = ( realm: Realm, uri: string ) => {
  const record = readJson<PhotoRecord>( state, photoKey( uri ) );
  const observation = record?.uuid && !realm.isClosed
    ? realm.objectForPrimaryKey<RealmObservation>( "Observation", record.uuid )
    : null;
  return observation?.isValid( )
    ? ( observation.observationPhotos ?? [] ).find(
      obsPhoto => normalizeDevicePhotoUri( obsPhoto.originalDevicePhotoUri ) === uri,
    )
    : undefined;
};

const readOutbox = ( ): OutboxEntry[] => outbox.getAllKeys( ).flatMap( key => {
  const raw = outbox.getString( key );
  const entry = raw
    ? readJson<{ uri: string; want: Want }>( outbox, key )
    : undefined;
  return raw && entry
    ? [{
      key, raw, uri: entry.uri, want: entry.want,
    }]
    : [];
} );

// Clears an entry the library has taken, unless it changed meanwhile.
const done = ( entry: OutboxEntry ) => {
  if ( outbox.getString( entry.key ) === entry.raw ) outbox.delete( entry.key );
};

const fileInAlbum = async ( entries: OutboxEntry[] ) => {
  if ( entries.length === 0 ) return;
  const added = await enqueuePhotoLibraryWrite(
    ( ) => addPhotosToImportedAlbum( entries.map( entry => libraryUriFor( entry.uri ) ) ),
  ).catch( ( ) => null );
  if ( added ) entries.forEach( done );
};

const unfileFromAlbum = async ( realm: Realm, entries: OutboxEntry[] ) => {
  if ( entries.length === 0 ) return;
  // A faved USB import isn't in Photos until it's saved there, and isn't in
  // the album then either: saving it is all there is to do.
  const staged = entries.filter( entry => isUnsavedStagedPhoto( entry.uri ) );
  if ( staged.length > 0 ) {
    const crops: Record<string, NormalizedCrop> = {};
    staged.forEach( ( { uri } ) => {
      const crop = savedNormalizedCrop( obsPhotoFor( realm, uri )?.photo ?? {} );
      if ( crop ) crops[uri] = crop;
    } );
    const { saved, failed } = await saveFavedStagedPhotos(
      staged.map( entry => entry.uri ),
      crops,
    );
    // New assets the photo picker would otherwise offer for import again.
    if ( saved.length > 0 && !realm.isClosed ) recordUploadedDevicePhotoUris( realm, saved );
    staged.filter( entry => !failed.includes( entry.uri ) ).forEach( done );
  }
  const inLibrary = entries.filter( entry => !staged.includes( entry ) );
  if ( inLibrary.length === 0 ) return;
  const removed = await enqueuePhotoLibraryWrite(
    ( ) => removePhotosFromImportedAlbum( inLibrary.map( entry => libraryUriFor( entry.uri ) ) ),
  ).catch( ( ) => false );
  if ( !removed ) return;
  const { saved, retry } = await restoreFavedDevicePhotos(
    realm,
    inLibrary.map( entry => entry.uri ),
    libraryUriFor,
    uri => obsPhotoFor( realm, uri )?.photo,
  ).catch( ( ) => ( { saved: [], retry: inLibrary.map( entry => entry.uri ) } ) );
  if ( saved.length > 0 && !realm.isClosed ) recordUploadedDevicePhotoUris( realm, saved );
  inLibrary.filter( entry => !retry.includes( entry.uri ) ).forEach( done );
};

// A faved staged photo stays until it's been saved to Photos.
const keepStaged = ( stagedName: string ) => {
  const uri = `usbStaging/${stagedName}`;
  return !!readJson<PhotoRecord>( state, `photo/${uri}` )?.faved
    && isUnsavedStagedPhoto( `/${uri}` );
};

const flushOnce = async ( ) => {
  const realm = source?.realm;
  if ( !realm || realm.isClosed ) return;
  const entries = readOutbox( );
  // Expiry runs on the clock, not on a change, so it goes here too.
  await expireStagedPhotos( keepStaged );
  if ( entries.length === 0 ) return;
  await fileInAlbum( entries.filter( entry => entry.want === "file" ) );
  await unfileFromAlbum( realm, entries.filter( entry => entry.want === "unfile" ) );
};

let flushing: Promise<void> | null = null;
let flushAgain = false;

const flush = ( ): Promise<void> => {
  if ( flushing ) {
    flushAgain = true;
    return flushing;
  }
  flushing = ( async ( ) => {
    do {
      flushAgain = false;
      // eslint-disable-next-line no-await-in-loop
      await flushOnce( );
    } while ( flushAgain );
  } )( ).catch( error => {
    logger.error( "Could not update the imported album", error );
  } ).finally( ( ) => {
    flushing = null;
  } );
  return flushing;
};

// Writes what's queued to the Photos library a moment from now, and lets
// expired staged photos go.
export const requestQueuedDeletionAlbumSync = ( ) => {
  if ( timer ) clearTimeout( timer );
  timer = setTimeout( ( ) => {
    timer = null;
    void flush( );
  }, DEBOUNCE_MS );
};

// Applies the observations Realm reports created or changed. Realm's first
// notification reports none.
export type AlbumObservation = Realm.Object<FavoritableObservation> & FavoritableObservation;

export const onObservationsChanged: Realm.CollectionChangeCallback<
  AlbumObservation,
  [number, AlbumObservation]
> = ( observations, changes ) => {
  let queued = false;
  [...changes.insertions, ...changes.newModifications].forEach( index => {
    const observation = observations[index];
    if ( observation?.isValid( ) && applyObservation( observation ) ) queued = true;
  } );
  if ( queued ) requestQueuedDeletionAlbumSync( );
};

// Builds the records from everything in Realm, once per install (and again
// whenever BACKFILL_VERSION is bumped), so the events that follow have
// something to compare against. Albums filed by earlier versions are brought
// in line the same way.
const backfill = ( realm: Realm ) => {
  if ( state.getNumber( BACKFILL_KEY ) === BACKFILL_VERSION ) return;
  realm.objects<FavoritableObservation>( "Observation" )
    .forEach( observation => { applyObservation( observation, true ); } );
  const removed = getRemovedGroupPhotoUris( );
  removed.forEach( uri => {
    state.set( photoKey( uri ), JSON.stringify( { faved: false } ) );
    enqueue( uri, "file" );
  } );
  startStagingClocks( removed );
  state.set( BACKFILL_KEY, BACKFILL_VERSION );
};

export const setQueuedDeletionAlbumSource = ( realm: Realm | null ) => {
  source = realm
    ? { realm }
    : null;
  if ( !realm ) return;
  backfill( realm );
  // Whatever an earlier launch left in the outbox.
  requestQueuedDeletionAlbumSync( );
};
