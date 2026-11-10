import { AppState } from "react-native";
import { MMKV } from "react-native-mmkv";
import type Realm from "realm";
import changeLanguage from "sharedHelpers/changeLanguage";
import {
  backUpDevicePhotos, markDevicePhotosToRestore, restoreDevicePhotos,
} from "sharedHelpers/cloudPhotoBackup";
import { cloud, hash, wait } from "sharedHelpers/cloudStore";
import { log } from "sharedHelpers/logger";
import useStore from "stores/useStore";
import zustandMMKVBackingStorage, { hadDataAtLaunch } from "stores/zustandMMKVBackingStorage";

// Settings and progress kept in MMKV, mirrored to iCloud key-value storage so
// deleting and reinstalling the app (or moving to a new iPhone) doesn't lose
// them. A fresh install restores them; after that, local changes are pushed
// up, and a key sign-out clears locally is cleared in iCloud too. Caches,
// tokens, Realm and anything naming a file inside the app are left out: a
// reinstall rebuilds the first three and the files are gone. The device photo
// records Realm keeps are backed up alongside, by cloudPhotoBackup.

const logger = log.extend( "cloudBackup" );

type Kind = "string" | "number" | "boolean";
interface BackedUp {
  // MMKV instance id, as the cloud key's prefix; "default" is the main store
  id: string;
  kind: Kind;
  // undefined backs up every key in the instance
  keys?: string[];
}

const BACKED_UP: BackedUp[] = [
  {
    id: "default",
    kind: "string",
    keys: [
      // useStore's partialize, less the Group Photos import in progress,
      // which points at files a reinstall deletes
      "persisted-zustand.isAdvancedUser",
      "persisted-zustand.obsDetailsTab",
      "persisted-zustand.layout",
      "persisted-zustand.exploreSavedSearches",
      "persisted-zustand.lastExploreSearch",
      "persisted-zustand.lastLocationPickerState",
      "persisted-zustand.firstObservationDefaults",
      "currentLocale",
      "myObservationsLayout",
      "exploreObservationsLayout",
      "exploreV2ObservationsLayout",
      "camera-pair-votes",
      "camera-pair-zooms",
      "speciesGameStats",
      "removedGroupPhotoUris",
    ],
  },
  // The persisted state's version
  { id: "default", kind: "number", keys: ["persisted-zustand."] },
  { id: "install-data", kind: "boolean", keys: ["onboardingShown"] },
  { id: "tunable-params", kind: "number" },
  // Without it, the next offload imports the whole drive again; the second is
  // what's imported but not yet deleted from it
  { id: "usb-import", kind: "string", keys: ["importedNames", "pendingDeletePaths"] },
  { id: "restored-device-photos", kind: "string", keys: ["restoredUris"] },
];

// Apple allows 1 MB in all; stay clear of it rather than have iCloud refuse
// the lot (a quota violation drops writes)
const MAX_TOTAL_CHARS = 800_000;
const RESTORE_POLL_MS = 15_000;
// How long a fresh install waits for iCloud's first download before giving
// up on restoring and starting to back up what it has. Nothing is backed up
// while it waits, since backing up the defaults would overwrite the backup.
const RESTORE_WAIT_MS = 60 * 60 * 1000;

// "pending" until a fresh install has restored (or given up), "done" after
const STATE_KEY = "state";
const PENDING_SINCE_KEY = "pendingSince";
// cloud key → hash of the value last sent, so only changes are sent and only
// keys this install wrote are ever removed from iCloud
const MIRRORED_KEY = "mirrored";

const backupStore = new MMKV( { id: "cloud-backup" } );
const instances: Record<string, MMKV> = { default: zustandMMKVBackingStorage };
const instance = ( id: string ) => {
  instances[id] ??= new MMKV( { id } );
  return instances[id];
};

const cloudKey = ( id: string, key: string ) => `${id}/${key}`;

const read = ( store: MMKV, key: string, kind: Kind ): string | undefined => {
  let value: string | number | boolean | undefined;
  if ( kind === "string" ) value = store.getString( key );
  else if ( kind === "number" ) value = store.getNumber( key );
  else value = store.getBoolean( key );
  return value === undefined
    ? undefined
    : String( value );
};

const write = ( store: MMKV, key: string, kind: Kind, value: string ) => {
  if ( kind === "string" ) {
    store.set( key, value );
  } else if ( kind === "boolean" ) {
    store.set( key, value === "true" );
  } else if ( Number.isFinite( Number( value ) ) ) {
    store.set( key, Number( value ) );
  }
};

const keysOf = ( { id, keys }: BackedUp ) => keys ?? instance( id ).getAllKeys( );

// Every backed-up value present locally, by cloud key
export const snapshot = ( ): Record<string, string> => {
  const values: Record<string, string> = {};
  BACKED_UP.forEach( backedUp => {
    const store = instance( backedUp.id );
    keysOf( backedUp ).forEach( key => {
      const value = read( store, key, backedUp.kind );
      if ( value !== undefined ) values[cloudKey( backedUp.id, key )] = value;
    } );
  } );
  return values;
};

const readMirrored = ( ): Record<string, string> => {
  try {
    return JSON.parse( backupStore.getString( MIRRORED_KEY ) ?? "{}" );
  } catch {
    return {};
  }
};

// Writes what iCloud holds into MMKV, then reloads everything that read it
// at launch
export const restore = ( values: Record<string, string> ) => {
  const mirrored: Record<string, string> = {};
  BACKED_UP.forEach( backedUp => {
    const prefix = `${backedUp.id}/`;
    Object.entries( values ).forEach( ( [key, value] ) => {
      if ( !key.startsWith( prefix ) ) return;
      const localKey = key.slice( prefix.length );
      if ( backedUp.keys && !backedUp.keys.includes( localKey ) ) return;
      write( instance( backedUp.id ), localKey, backedUp.kind, value );
      mirrored[key] = hash( value );
    } );
  } );
  backupStore.set( MIRRORED_KEY, JSON.stringify( mirrored ) );
  useStore.persist.rehydrate( );
  const locale = zustandMMKVBackingStorage.getString( "currentLocale" );
  if ( locale ) changeLanguage( locale );
  logger.info( `Restored ${Object.keys( mirrored ).length} values from iCloud` );
};

let mirroring: Promise<void> | null = null;
let backupRealm: Realm | null = null;

// Sends iCloud whatever changed since the last mirror
export const mirror = ( ): Promise<void> => {
  if ( !cloud || backupStore.getString( STATE_KEY ) !== "done" ) return Promise.resolve( );
  mirroring ??= ( async ( ) => {
    const mirrored = readMirrored( );
    const next: Record<string, string> = {};
    const changed: Record<string, string> = {};
    let total = 0;
    Object.entries( snapshot( ) ).forEach( ( [key, value] ) => {
      total += key.length + value.length;
      if ( total > MAX_TOTAL_CHARS ) {
        // Leave whatever iCloud already has for it
        if ( mirrored[key] ) next[key] = mirrored[key];
        return;
      }
      next[key] = hash( value );
      if ( mirrored[key] !== next[key] ) changed[key] = value;
    } );
    if ( total > MAX_TOTAL_CHARS ) {
      logger.warn( `Backup is ${total} chars, past ${MAX_TOTAL_CHARS}; not all of it was sent` );
    }
    const removals = Object.keys( mirrored ).filter( key => !( key in next ) );
    if ( Object.keys( changed ).length > 0 || removals.length > 0 ) {
      await cloud.update( changed, removals );
      backupStore.set( MIRRORED_KEY, JSON.stringify( next ) );
    }
    if ( backupRealm ) await backUpDevicePhotos( backupRealm );
  } )( ).catch( error => {
    logger.error( "iCloud backup failed:", error );
  } ).finally( ( ) => {
    mirroring = null;
  } );
  return mirroring;
};

// A fresh install restores what iCloud has. iCloud downloads it some time
// after launch, so keep asking until it turns up or there's clearly nothing.
const restoreWhenAvailable = async ( ) => {
  if ( !cloud ) return;
  const pendingSince = backupStore.getNumber( PENDING_SINCE_KEY ) ?? Date.now( );
  backupStore.set( PENDING_SINCE_KEY, pendingSince );
  if ( await cloud.isAvailable( ) ) {
    while ( Date.now( ) - pendingSince < RESTORE_WAIT_MS ) {
      // eslint-disable-next-line no-await-in-loop
      const values = await cloud.getAll( );
      if ( Object.keys( values ).length > 0 ) {
        restore( values );
        markDevicePhotosToRestore( values );
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await wait( RESTORE_POLL_MS );
    }
  }
  backupStore.set( STATE_KEY, "done" );
  backupStore.delete( PENDING_SINCE_KEY );
};

let started = false;

// Called once startup has signed a fresh install out, which clears MMKV, so
// nothing restored here gets cleared by it
export const startCloudBackup = async ( realm: Realm ) => {
  if ( !cloud || started ) return;
  started = true;
  backupRealm = realm;
  if ( !backupStore.contains( STATE_KEY ) ) {
    backupStore.set( STATE_KEY, hadDataAtLaunch
      ? "done"
      : "pending" );
  }
  if ( backupStore.getString( STATE_KEY ) === "pending" ) {
    await restoreWhenAvailable( );
  }
  // Can take a while: the document downloads after key-value storage does
  restoreDevicePhotos( realm ).catch( error => {
    logger.error( "Restoring device photos from iCloud failed:", error );
  } );
  await mirror( );
  // Leaving the app is the last chance before it's killed, so every change
  // goes up then
  AppState.addEventListener( "change", state => {
    if ( state === "background" ) mirror( );
  } );
};
