import {
  copyFile, mkdir, readDir, unlink,
} from "@dr.pogodin/react-native-fs";
import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import { photoLibraryPhotosPath, usbStagingPath } from "appConstants/paths";
import { sortGroupsByTime } from "components/PhotoImporter/helpers/groupPhotoHelpers";
import type { GroupedMediaItem } from "components/PhotoImporter/helpers/photoLibraryMediaHelpers";
import { MMKV } from "react-native-mmkv";
import { log } from "sharedHelpers/logger";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import { getTunable } from "sharedHelpers/tunableParams";

const logger = log.extend( "usbStaging" );

// Photos copied off a USB drive land here instead of in the Photos library, so
// the ones the user doesn't fave never need deleting from it. A staged photo
// is offered to Group Photos once; after that it is saved to Photos (into an
// album the user moves to their Shared Library) as soon as an observation it
// is on is faved, or deleted once it is older than usbStagingRetentionDays.
// Staged names are "<stagedAtMs>_<file name>", and photos are matched to
// observations by that name alone: the app container's absolute path changes
// across app updates.

export const SHARED_LIBRARY_ALBUM_TITLE = "→ Shared Library";

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFERED_KEY = "offeredNames";
const store = new MMKV( { id: "usb-staging" } );

const getOffered = ( ): string[] => JSON.parse( store.getString( OFFERED_KEY ) ?? "[]" );
const setOffered = ( names: string[] ) => store.set( OFFERED_KEY, JSON.stringify( names ) );

export const stagedPathFor = ( relativePath: string ) => (
  `${usbStagingPath}/${Date.now( )}_${relativePath.split( "/" ).pop( )}`
);

const stagedNameFromUri = ( uri: string ) => uri.match( /\/usbStaging\/([^/]+)$/ )?.[1];

const readStaged = async ( ) => ( await readDir( usbStagingPath ).catch( ( ) => [] ) )
  .filter( item => item.isFile( ) && !item.name.endsWith( ".partial" ) );

// Copies the staged photos not yet offered to Group Photos into the importer's
// folder, as Group Photos groups, and records them as offered.
export const takeUnofferedStagedGroups = async ( ): Promise<GroupedMediaItem[]> => {
  const offered = new Set( getOffered( ) );
  const items = ( await readStaged( ) ).filter( item => !offered.has( item.name ) );
  if ( items.length === 0 ) return [];
  await mkdir( photoLibraryPhotosPath );
  const groups: GroupedMediaItem[] = [];
  for ( const item of items ) {
    const dest = `${photoLibraryPhotosPath}/${item.name}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      await unlink( dest ).catch( ( ) => undefined );
      // eslint-disable-next-line no-await-in-loop
      await copyFile( item.path, dest );
    } catch ( error ) {
      logger.error( "Could not copy a staged USB photo for Group Photos", error );
      // eslint-disable-next-line no-continue
      continue;
    }
    offered.add( item.name );
    groups.push( {
      photos: [{
        image: {
          uri: `file://${dest}`,
          fileName: item.name,
          type: "image/jpeg",
          // Seconds, like the photo library picker. The copy kept the file's
          // modification date from the card, which is when it was taken.
          timestamp: String( Math.round( ( item.mtime?.getTime( ) ?? Date.now( ) ) / 1000 ) ),
        },
        originalDevicePhotoUri: `file://${item.path}`,
        croppable: true,
      }],
    } );
  }
  setOffered( [...offered] );
  return sortGroupsByTime( groups );
};

let sweeping = false;

// favoritedUris: device photo URIs on observations the user has faved.
export const sweepUsbStaging = async ( favoritedUris: string[] ) => {
  if ( sweeping ) return;
  sweeping = true;
  try {
    const favorited = new Set( favoritedUris.map( stagedNameFromUri ).filter( Boolean ) );
    const offered = new Set( getOffered( ) );
    const retentionMs = getTunable( "usbStagingRetentionDays" ) * DAY_MS;
    const removed = new Set<string>( );
    let saved = 0;
    for ( const item of await readStaged( ) ) {
      if ( favorited.has( item.name ) ) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await enqueuePhotoLibraryWrite( ( ) => CameraRoll.saveAsset(
          `file://${item.path}`,
          { type: "photo", album: SHARED_LIBRARY_ALBUM_TITLE },
        ) ).then( ( ) => true, error => {
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
        offered.has( item.name )
        && Date.now( ) - ( Number( item.name.split( "_" )[0] ) || 0 ) > retentionMs
      ) {
        // eslint-disable-next-line no-await-in-loop
        await unlink( item.path ).catch( ( ) => undefined );
        removed.add( item.name );
      }
    }
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
