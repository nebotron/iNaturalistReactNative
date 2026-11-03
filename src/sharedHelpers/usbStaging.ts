import {
  readDir, unlink,
} from "@dr.pogodin/react-native-fs";
import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import { usbStagingPath } from "appConstants/paths";
import { NativeModules, Platform } from "react-native";
import { MMKV } from "react-native-mmkv";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import { getTunable } from "sharedHelpers/tunableParams";

const logger = log.extend( "usbStaging" );

// Photos copied off a USB drive land here instead of in the Photos library, so
// the ones the user doesn't fave never need deleting from it. A staged photo
// is offered to Group Photos once. It is saved to Photos (into an album the
// user moves to their Shared Library) as soon as an observation it is on is
// faved. Otherwise it is deleted usbStagingRetentionDays after it was first
// seen on an observation or removed in Group Photos or the cropper. Staged
// names are "<stagedAtMs>_<file name>", and photos are matched to observations
// by that name alone: the app container's absolute path changes across app
// updates.

const SHARED_LIBRARY_ALBUM_TITLE = "→ Shared Library";

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFERED_KEY = "offeredNames";
// Staged name → when its retention clock started.
const CLOCK_KEY = "clockStartedAt";
const store = new MMKV( { id: "usb-staging" } );

const getOffered = ( ): string[] => JSON.parse( store.getString( OFFERED_KEY ) ?? "[]" );
const setOffered = ( names: string[] ) => store.set( OFFERED_KEY, JSON.stringify( names ) );
const getClocks = ( ): Record<string, number> => JSON.parse( store.getString( CLOCK_KEY ) ?? "{}" );

export const stagedPathFor = ( relativePath: string ) => (
  `${usbStagingPath}/${Date.now( )}_${relativePath.split( "/" ).pop( )}`
);

const stagedNameFromUri = ( uri: string ) => uri.match( /\/usbStaging\/([^/]+)$/ )?.[1];

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
    saveCroppedAsset?: ( uri: string, crop: NormalizedCrop ) => Promise<{ uri: string }>;
    addAssetsToAlbum?: ( phUris: string[], album: string ) => Promise<unknown>;
  };
};

const isFullFrame = ( { x, y, w, h }: NormalizedCrop ) => (
  x <= 0.001 && y <= 0.001 && w >= 0.999 && h >= 0.999
);

// Saves a staged photo to Photos, cropped as it is on its observation. On iOS
// the crop is a PhotoKit edit over the full original, so Revert in Photos
// recovers the whole image. Resolves the new asset's ph:// URI.
const saveStagedPhoto = async ( path: string, crop?: NormalizedCrop ) => {
  if ( crop && !isFullFrame( crop ) && Platform.OS === "ios" && ImageCropper?.saveCroppedAsset ) {
    const { uri } = await ImageCropper.saveCroppedAsset( `file://${path}`, crop );
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

let sweeping = false;

// favoritedUris: device photo URIs on observations the user has faved.
// unfavoritedUris: those on other observations, or removed from Group Photos.
// onSavedToPhotos: the library URIs of faved photos just saved to Photos, which
// are new assets the photo picker would otherwise offer again.
// crops: device photo URI → its crop on the observation.
export const sweepUsbStaging = async (
  favoritedUris: string[],
  unfavoritedUris: string[],
  onSavedToPhotos?: ( uris: string[] ) => void,
  crops: Record<string, NormalizedCrop> = {},
) => {
  if ( sweeping ) return;
  sweeping = true;
  try {
    const favorited = new Set( favoritedUris.map( stagedNameFromUri ).filter( Boolean ) );
    const cropsByName = Object.fromEntries( Object.entries( crops )
      .map( ( [uri, crop] ) => [stagedNameFromUri( uri ), crop] ) );
    const retentionMs = getTunable( "usbStagingRetentionDays" ) * DAY_MS;
    const staged = await readStaged( );
    const stagedNames = new Set( staged.map( item => item.name ) );
    const clocks = Object.fromEntries( Object.entries( getClocks( ) )
      .filter( ( [name] ) => stagedNames.has( name ) ) );
    unfavoritedUris.forEach( uri => {
      const name = stagedNameFromUri( uri );
      if ( name && stagedNames.has( name ) && clocks[name] === undefined ) {
        clocks[name] = Date.now( );
      }
    } );
    const removed = new Set<string>( );
    const savedUris: string[] = [];
    let saved = 0;
    for ( const item of staged ) {
      if ( favorited.has( item.name ) ) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await enqueuePhotoLibraryWrite(
          ( ) => saveStagedPhoto( item.path, cropsByName[item.name] ),
        ).then( uri => {
          if ( uri ) savedUris.push( uri );
          return true;
        }, error => {
          logger.error( "Could not save a faved USB photo to Photos", error );
          return false;
        } );
        // The library refused; keep the rest staged for the next sweep.
        if ( !ok ) break;
        saved += 1;
        // eslint-disable-next-line no-await-in-loop
        await unlink( item.path ).catch( ( ) => undefined );
        removed.add( item.name );
      } else if (
        clocks[item.name] !== undefined
        && Date.now( ) - clocks[item.name] > retentionMs
      ) {
        // eslint-disable-next-line no-await-in-loop
        await unlink( item.path ).catch( ( ) => undefined );
        removed.add( item.name );
      }
    }
    if ( savedUris.length > 0 ) onSavedToPhotos?.( savedUris );
    removed.forEach( name => delete clocks[name] );
    store.set( CLOCK_KEY, JSON.stringify( clocks ) );
    if ( removed.size > 0 ) {
      setOffered( getOffered( ).filter( name => !removed.has( name ) ) );
      logger.info( `USB staging: saved ${saved} faved photo(s) to Photos, `
        + `expired ${removed.size - saved}` );
    }
  } catch ( error ) {
    logger.error( "USB staging sweep failed", error );
  } finally {
    sweeping = false;
  }
};
