import {
  exists, readDir, unlink,
} from "@dr.pogodin/react-native-fs";
import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import { usbStagingPath } from "appConstants/paths";
import { NativeModules, Platform } from "react-native";
import { MMKV } from "react-native-mmkv";
import { getAnimalCrop } from "sharedHelpers/animalCropLog";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import { getTunable } from "sharedHelpers/tunableParams";

const logger = log.extend( "usbStaging" );

// Photos copied off a USB drive land here instead of in the Photos library, so
// the ones the user doesn't fave never need deleting from it. A staged photo
// is deleted usbStagingRetentionDays after its upload to iNaturalist finished
// (faved or not) or it was removed in the photo picker, Group Photos or the
// cropper. One never uploaded or removed is kept indefinitely. A photo on a
// faved observation is also saved to Photos (into an album the user moves to
// their Shared Library) as soon as the observation is faved, and is never
// deleted before that save succeeds. Staged names are "<stagedAtMs>_<file
// name>", and photos are matched to observations by that name alone: the app
// container's absolute path changes across app updates.
//
// Everything is stored one photo to a key, so each lookup and each change
// costs the same however many photos have been staged. Holding a map per
// purpose in one JSON value meant reading and parsing all of it for every
// photo, which made the deletion album's sync quadratic.

const SHARED_LIBRARY_ALBUM_TITLE = "→ Shared Library";

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFERED_KEY = "offeredNames";
const store = new MMKV( { id: "usb-staging" } );
store.delete( "clockStartedAt" );

// Staged name → the ph:// URI it was saved to Photos as when faved ("" when
// the save gave no URI). The observation keeps the staged URI, so this is how
// an unfave finds the asset.
const savedKey = ( name: string ) => `saved/${name}`;
// Staged name → its import crop. The observation's copy of the crop is
// local-only and can be lost (e.g. to a re-download), so a faved photo would
// otherwise be saved to Photos uncropped.
const cropKey = ( name: string ) => `crop/${name}`;
// Staged name → when its retention clock started.
const clockKey = ( name: string ) => `clock/${name}`;
// The names whose clocks started on each day, as numbered entries, so adding
// one is a single write and expiry reads only the days that have come due.
const dueCountKey = ( day: number ) => `dueCount/${day}`;
const dueKey = ( day: number, index: number ) => `due/${day}/${index}`;
// The last day whose clocks have all been dealt with.
const EXPIRED_THROUGH_KEY = "expiredThrough";

const dayOf = ( ms: number ) => Math.floor( ms / DAY_MS );

const addDue = ( day: number, name: string ) => {
  const count = store.getNumber( dueCountKey( day ) ) ?? 0;
  store.set( dueKey( day, count ), name );
  store.set( dueCountKey( day ), count + 1 );
};

// Earlier versions kept each of these as one JSON map; split them once.
const migrateBlob = <T>( key: string, write: ( name: string, value: T ) => void ) => {
  const raw = store.getString( key );
  if ( raw === undefined ) return;
  try {
    Object.entries( JSON.parse( raw ) as Record<string, T> )
      .forEach( ( [name, value] ) => write( name, value ) );
  } catch ( error ) {
    logger.warn( `Discarding unreadable USB staging ${key}`, error );
  }
  store.delete( key );
};
migrateBlob<string>( "savedUris", ( name, uri ) => store.set( savedKey( name ), uri ) );
migrateBlob<NormalizedCrop>(
  "importCrops",
  ( name, crop ) => store.set( cropKey( name ), JSON.stringify( crop ) ),
);
migrateBlob<number>( "uploadedOrRemovedAt", ( name, startedAt ) => {
  store.set( clockKey( name ), startedAt );
  addDue( dayOf( startedAt ), name );
} );

const getOffered = ( ): string[] => JSON.parse( store.getString( OFFERED_KEY ) ?? "[]" );
const setOffered = ( names: string[] ) => store.set( OFFERED_KEY, JSON.stringify( names ) );
const getSavedUri = ( name: string ) => store.getString( savedKey( name ) );
const getImportCrop = ( name: string ): NormalizedCrop | undefined => {
  const raw = store.getString( cropKey( name ) );
  return raw
    ? JSON.parse( raw )
    : undefined;
};

export const stagedPathFor = ( relativePath: string ) => (
  `${usbStagingPath}/${Date.now( )}_${relativePath.split( "/" ).pop( )}`
);

const stagedNameFromUri = ( uri: string ) => uri.match( /\/usbStaging\/([^/]+)$/ )?.[1];

export const isStagedDevicePhoto = ( uri: string ) => !!stagedNameFromUri( uri );

export const recordStagedImportCrop = ( uri: string, crop: NormalizedCrop ) => {
  const name = stagedNameFromUri( uri );
  if ( !name ) return;
  store.set( cropKey( name ), JSON.stringify( crop ) );
};

// The Photos asset a staged photo URI was saved as, or the URI itself.
export const libraryUriForDevicePhoto = ( uri: string ) => {
  const name = stagedNameFromUri( uri );
  return ( name && getSavedUri( name ) ) || uri;
};

// Whether a staged photo still has to be saved to Photos before it's faved.
export const isUnsavedStagedPhoto = ( uri: string ) => {
  const name = stagedNameFromUri( uri );
  return !!name && getSavedUri( name ) === undefined;
};

// Where a staged photo's original can be read now: the Photos asset it was
// saved as, else the staged file under the current app container (the
// recorded path names the container it was imported in).
export const readableUriForDevicePhoto = ( uri: string ) => {
  const name = stagedNameFromUri( uri );
  if ( !name ) return uri;
  return getSavedUri( name ) || `file://${usbStagingPath}/${name}`;
};

const readStaged = async ( ) => ( await readDir( usbStagingPath ).catch( ( ) => [] ) )
  .filter( item => item.isFile( ) && !item.name.endsWith( ".partial" ) );

// Identifies a device photo URI across app updates, which move the app
// container and so every staged photo's absolute path.
export const devicePhotoKey = ( uri: string ) => {
  const name = stagedNameFromUri( uri );
  return name
    ? `usbStaging/${name}`
    : uri;
};

// Staged photos as photo picker nodes, newest first, so the picker can offer
// them alongside the Photos library (which they are never saved to).
export const listStagedPhotoNodes = async ( ): Promise<PhotoIdentifier["node"][]> => (
  ( await readStaged( ) ).map( item => {
    // Seconds, like CameraRoll. The copy kept the card's modification date.
    const timestamp = Math.round( ( item.mtime?.getTime( ) ?? Date.now( ) ) / 1000 );
    return {
      id: "",
      type: "image",
      subTypes: [],
      sourceType: "UserLibrary",
      group_name: [],
      image: {
        filename: item.name,
        filepath: item.path,
        extension: item.name.split( "." ).pop( ) ?? null,
        uri: `file://${item.path}`,
        height: 0,
        width: 0,
        fileSize: Number( item.size ),
        playableDuration: 0,
        orientation: null,
      },
      timestamp,
      modificationTimestamp: timestamp,
      location: null,
    };
  } ).sort( ( a, b ) => b.timestamp - a.timestamp )
);

const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    saveCroppedAsset?: (
      uri: string,
      crop: NormalizedCrop,
    ) => Promise<{ uri: string; cropped: boolean }>;
    addAssetsToAlbum?: ( phUris: string[], album: string ) => Promise<unknown>;
  };
};

const isFullFrame = ( {
  x, y, w, h,
}: NormalizedCrop ) => (
  x <= 0.001 && y <= 0.001 && w >= 0.999 && h >= 0.999
);

// Saves a local photo to Photos, cropped as it is on its observation. On iOS
// the crop is a PhotoKit edit over the full original, so Revert in Photos
// recovers the whole image. Resolves the new asset's ph:// URI.
export const saveLocalPhotoToLibrary = async ( path: string, crop?: NormalizedCrop ) => {
  if ( crop && !isFullFrame( crop ) && Platform.OS === "ios" && ImageCropper?.saveCroppedAsset ) {
    const { uri, cropped } = await ImageCropper.saveCroppedAsset( `file://${path}`, crop );
    // The original still landed whole; only the edit over it didn't.
    if ( !cropped ) logger.warn( `Saved a faved USB photo to Photos without its crop: ${uri}` );
    await ImageCropper.addAssetsToAlbum?.( [uri], SHARED_LIBRARY_ALBUM_TITLE );
    return uri;
  }
  const asset = await CameraRoll.saveAsset(
    `file://${path}`,
    { type: "photo", album: SHARED_LIBRARY_ALBUM_TITLE },
  );
  return asset?.node?.id
    ? `ph://${asset.node.id}`
    : undefined;
};

let breakdownLoggedAt = 0;

// What is holding the staging folder's space, at most once a day: photos
// whose retention clock is running, and photos kept indefinitely because they
// were never uploaded or removed.
const logStagingBreakdown = (
  staged: { name: string; size: number | string }[],
  clocks: Record<string, number>,
) => {
  if ( Date.now( ) - breakdownLoggedAt < DAY_MS ) return;
  breakdownLoggedAt = Date.now( );
  const MB = 1024 * 1024;
  const tally: Record<string, { n: number; mb: number }> = {};
  const add = ( key: string, bytes: number ) => {
    tally[key] = tally[key] ?? { n: 0, mb: 0 };
    tally[key].n += 1;
    tally[key].mb += bytes / MB;
  };
  staged.forEach( item => {
    const bytes = Number( item.size ) || 0;
    const ext = ( item.name.split( "." ).pop( ) ?? "" ).toLowerCase( );
    const state = clocks[item.name] === undefined
      ? "kept"
      : "expiring";
    add( state, bytes );
    add( `${state}.${ext}`, bytes );
  } );
  const rounded = Object.fromEntries( Object.entries( tally )
    .map( ( [key, { n, mb }] ) => [key, { n, mb: Math.round( mb ) }] ) );
  logger.infoWithExtra( "usb_staging_breakdown", {
    files: staged.length,
    byState: JSON.stringify( rounded ),
  } );
};

// Saves the staged photos among a faved observation's device photos to
// Photos, each once, cropped as it is on the observation (crops: device photo
// URI → crop). Resolves the new assets' URIs, and the device photos whose save
// failed and should be tried again.
export const saveFavedStagedPhotos = async (
  deviceUris: string[],
  crops: Record<string, NormalizedCrop> = {},
): Promise<{ saved: string[]; failed: string[] }> => {
  const saved: string[] = [];
  const failed: string[] = [];
  for ( const uri of deviceUris ) {
    const name = stagedNameFromUri( uri );
    // eslint-disable-next-line no-continue
    if ( !name || getSavedUri( name ) !== undefined ) continue;
    const path = `${usbStagingPath}/${name}`;
    // Expired or never copied: there's nothing left to save.
    // eslint-disable-next-line no-await-in-loop, no-continue
    if ( !await exists( path ).catch( ( ) => false ) ) continue;
    const crop = crops[uri]
      ?? getImportCrop( name )
      ?? getAnimalCrop( `file://${path}` )
      ?? undefined;
    // eslint-disable-next-line no-await-in-loop
    const ok = await enqueuePhotoLibraryWrite(
      ( ) => saveLocalPhotoToLibrary( path, crop ),
    ).then( savedUri => {
      if ( savedUri ) saved.push( savedUri );
      // Recorded even without a URI, so it's saved once, not on every fave.
      store.set( savedKey( name ), savedUri ?? "" );
      return true;
    }, error => {
      logger.error( "Could not save a faved USB photo to Photos", error );
      return false;
    } );
    if ( !ok ) failed.push( uri );
  }
  if ( saved.length > 0 ) {
    logger.info( `USB staging: saved ${saved.length} faved photo(s) to Photos` );
  }
  return { saved, failed };
};

// Starts the retention clock of each staged photo among these device photos
// whose upload finished, or which were removed, unless it's already running.
export const startStagingClocks = ( deviceUris: string[], now = Date.now( ) ) => {
  deviceUris.forEach( uri => {
    const name = stagedNameFromUri( uri );
    if ( !name || store.getNumber( clockKey( name ) ) !== undefined ) return;
    store.set( clockKey( name ), now );
    addDue( dayOf( now ), name );
  } );
};

let expiring = false;

// Deletes the staged photos whose retention has run out. Reads only the days
// that came due since the last run, so each photo is looked at once. Days are
// whole, so a photo can outlive its retention by up to a day.
// keep: staged names that mustn't go yet (faved, but not yet saved to Photos);
// they're looked at again tomorrow.
export const expireStagedPhotos = async (
  keep: ( stagedName: string ) => boolean = ( ) => false,
) => {
  if ( expiring ) return;
  expiring = true;
  try {
    const retentionMs = getTunable( "usbStagingRetentionDays" ) * DAY_MS;
    // The last day whose clocks have all run out.
    const lastDueDay = dayOf( Date.now( ) - retentionMs ) - 1;
    const removed = new Set<string>( );
    // Without a record, start from the earliest day anything could be due.
    let day = ( store.getNumber( EXPIRED_THROUGH_KEY ) ?? -1 ) + 1;
    if ( day === 0 ) {
      const firstDay = store.getAllKeys( )
        .filter( key => key.startsWith( "dueCount/" ) )
        .map( key => Number( key.slice( "dueCount/".length ) ) )
        .reduce( ( min, d ) => Math.min( min, d ), Infinity );
      day = Number.isFinite( firstDay )
        ? firstDay
        : lastDueDay + 1;
    }
    for ( ; day <= lastDueDay; day += 1 ) {
      const count = store.getNumber( dueCountKey( day ) ) ?? 0;
      for ( let index = 0; index < count; index += 1 ) {
        const name = store.getString( dueKey( day, index ) );
        if ( name && keep( name ) ) {
          addDue( lastDueDay + 1, name );
        } else if ( name ) {
          // eslint-disable-next-line no-await-in-loop
          await unlink( `${usbStagingPath}/${name}` ).catch( ( ) => undefined );
          store.delete( clockKey( name ) );
          store.delete( cropKey( name ) );
          removed.add( name );
        }
        store.delete( dueKey( day, index ) );
      }
      store.delete( dueCountKey( day ) );
      store.set( EXPIRED_THROUGH_KEY, day );
    }
    // Also when nothing was due, so the next run starts here, not from a scan.
    store.set( EXPIRED_THROUGH_KEY, day - 1 );
    if ( removed.size > 0 ) {
      setOffered( getOffered( ).filter( name => !removed.has( name ) ) );
      logger.info( `USB staging: expired ${removed.size}` );
    }
    if ( Date.now( ) - breakdownLoggedAt >= DAY_MS ) {
      const staged = await readStaged( );
      const clocks: Record<string, number> = {};
      staged.forEach( item => {
        const startedAt = store.getNumber( clockKey( item.name ) );
        if ( startedAt !== undefined ) clocks[item.name] = startedAt;
      } );
      logStagingBreakdown( staged, clocks );
    }
  } catch ( error ) {
    logger.error( "USB staging expiry failed", error );
  } finally {
    expiring = false;
  }
};
