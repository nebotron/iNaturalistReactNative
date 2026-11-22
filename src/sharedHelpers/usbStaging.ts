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

const SHARED_LIBRARY_ALBUM_TITLE = "→ Shared Library";

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFERED_KEY = "offeredNames";
// Staged name → when its retention clock started. Renamed when the clock
// moved from "first on an observation" to "upload finished", so no photo keeps
// a clock started before its upload.
const CLOCK_KEY = "uploadedOrRemovedAt";
const store = new MMKV( { id: "usb-staging" } );
store.delete( "clockStartedAt" );

const getOffered = ( ): string[] => JSON.parse( store.getString( OFFERED_KEY ) ?? "[]" );
const setOffered = ( names: string[] ) => store.set( OFFERED_KEY, JSON.stringify( names ) );
const getClocks = ( ): Record<string, number> => JSON.parse( store.getString( CLOCK_KEY ) ?? "{}" );
// Staged name → the ph:// URI it was saved to Photos as when faved. The
// observation keeps the staged URI, so this is how an unfave finds the asset.
const SAVED_KEY = "savedUris";
const getSaved = ( ): Record<string, string> => JSON.parse( store.getString( SAVED_KEY ) ?? "{}" );
// Staged name → its import crop. The observation's copy of the crop is
// local-only and can be lost (e.g. to a re-download), so a faved photo would
// otherwise be saved to Photos uncropped.
const IMPORT_CROPS_KEY = "importCrops";
const getImportCrops = ( ): Record<string, NormalizedCrop> => JSON.parse(
  store.getString( IMPORT_CROPS_KEY ) ?? "{}",
);

export const stagedPathFor = ( relativePath: string ) => (
  `${usbStagingPath}/${Date.now( )}_${relativePath.split( "/" ).pop( )}`
);

const stagedNameFromUri = ( uri: string ) => uri.match( /\/usbStaging\/([^/]+)$/ )?.[1];

export const recordStagedImportCrop = ( uri: string, crop: NormalizedCrop ) => {
  const name = stagedNameFromUri( uri );
  if ( !name ) return;
  store.set( IMPORT_CROPS_KEY, JSON.stringify( { ...getImportCrops( ), [name]: crop } ) );
};

// Staged name → the Photos asset it was saved as. Read it once and pass it to
// libraryUriForDevicePhoto when looking up many photos: each read parses the
// whole map.
export const readSavedStagedUris = getSaved;

// The Photos asset a staged photo URI was saved as, or the URI itself.
export const libraryUriForDevicePhoto = (
  uri: string,
  saved?: Record<string, string>,
) => {
  const name = stagedNameFromUri( uri );
  return ( name && ( saved ?? getSaved( ) )[name] ) || uri;
};

// Where a staged photo's original can be read now: the Photos asset it was
// saved as, else the staged file under the current app container (the
// recorded path names the container it was imported in).
export const readableUriForDevicePhoto = ( uri: string ) => {
  const name = stagedNameFromUri( uri );
  if ( !name ) return uri;
  return getSaved( )[name] || `file://${usbStagingPath}/${name}`;
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

// Starts the retention clock of each staged photo among these: device photos
// whose upload to iNaturalist just finished, or that were just removed in the
// photo picker, Group Photos or the cropper. A clock already running is left.
export const startUsbStagingClocks = ( uris: string[] ) => {
  const names = uris.map( stagedNameFromUri ).filter( ( name ): name is string => !!name );
  if ( names.length === 0 ) return;
  const clocks = getClocks( );
  const unclocked = names.filter( name => clocks[name] === undefined );
  if ( unclocked.length === 0 ) return;
  unclocked.forEach( name => { clocks[name] = Date.now( ); } );
  store.set( CLOCK_KEY, JSON.stringify( clocks ) );
};

// Saves to Photos, once each, the staged photos on an observation that is
// faved, each with its crop on the observation (else its import crop).
// Resolves the new assets' URIs, which the photo picker would otherwise offer
// for import again, and whether Photos refused one: the rest wait for the
// next try, and expiry keeps them until they're saved.
export const saveFavedStagedPhotos = async (
  photos: { uri: string; crop?: NormalizedCrop }[],
): Promise<{ saved: string[]; refused: boolean }> => {
  const saved: string[] = [];
  let refused = false;
  for ( const photo of photos ) {
    const name = stagedNameFromUri( photo.uri );
    const path = `${usbStagingPath}/${name}`;
    // eslint-disable-next-line no-continue, no-await-in-loop
    if ( !name || name in getSaved( ) || !await exists( path ).catch( ( ) => false ) ) continue;
    // Photos cropped before importCrops existed: the crop log has them by the
    // staged file's URI.
    const crop = photo.crop
      ?? getImportCrops( )[name]
      ?? getAnimalCrop( `file://${path}` )
      ?? undefined;
    // eslint-disable-next-line no-await-in-loop
    const ok = await enqueuePhotoLibraryWrite(
      ( ) => saveLocalPhotoToLibrary( path, crop ),
    ).then( uri => {
      if ( uri ) saved.push( uri );
      // Recorded even without a URI, so it's saved once, not every time.
      store.set( SAVED_KEY, JSON.stringify( { ...getSaved( ), [name]: uri ?? "" } ) );
      return true;
    }, error => {
      logger.error( "Could not save a faved USB photo to Photos", error );
      return false;
    } );
    if ( !ok ) {
      refused = true;
      break;
    }
  }
  if ( saved.length > 0 ) {
    logger.info( `USB staging: saved ${saved.length} faved photo(s) to Photos` );
  }
  return { saved, refused };
};

let expiring = false;

// Deletes the staged photos whose retention clock ran out, but never a faved
// one before it's saved to Photos. Reads the folder, and asks isFaved only
// about photos past their time, so it costs nothing per observation.
// isFaved: whether the photo with this staged name is on a faved observation.
export const expireUsbStaging = async (
  isFaved: ( stagedName: string ) => boolean = ( ) => false,
) => {
  if ( expiring ) return;
  expiring = true;
  try {
    const retentionMs = getTunable( "usbStagingRetentionDays" ) * DAY_MS;
    const staged = await readStaged( );
    const stagedNames = new Set( staged.map( item => item.name ) );
    const startClocks = getClocks( );
    const savedNames = getSaved( );
    const removed = new Set<string>( );
    for ( const item of staged ) {
      const startedAt = startClocks[item.name];
      if (
        startedAt !== undefined
        && Date.now( ) - startedAt > retentionMs
        && ( item.name in savedNames || !isFaved( item.name ) )
      ) {
        // eslint-disable-next-line no-await-in-loop
        await unlink( item.path ).catch( ( ) => undefined );
        removed.add( item.name );
      }
    }
    // Read again: a clock may have started while the folder was read
    const clocks = getClocks( );
    Object.keys( startClocks ).forEach( name => {
      if ( removed.has( name ) || !stagedNames.has( name ) ) delete clocks[name];
    } );
    store.set( CLOCK_KEY, JSON.stringify( clocks ) );
    if ( removed.size > 0 ) {
      const keptCrops = Object.entries( getImportCrops( ) )
        .filter( ( [name] ) => !removed.has( name ) );
      store.set( IMPORT_CROPS_KEY, JSON.stringify( Object.fromEntries( keptCrops ) ) );
      setOffered( getOffered( ).filter( name => !removed.has( name ) ) );
      logger.info( `USB staging: expired ${removed.size}` );
    }
    logStagingBreakdown( staged.filter( item => !removed.has( item.name ) ), clocks );
  } catch ( error ) {
    logger.error( "USB staging expiry failed", error );
  } finally {
    expiring = false;
  }
};
