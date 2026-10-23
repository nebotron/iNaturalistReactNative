import { NativeModules, Platform } from "react-native";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "importedPhotoAlbum" );

const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    addAssetsToAlbum?: ( phUris: string[], album: string ) => Promise<{
      added: number;
      requested: number;
      alreadyIn: number;
      createdAlbum?: boolean;
      // Albums with this title; iCloud can leave more than one.
      albums?: number;
      // Of the requested photos, how many every such album holds afterwards.
      inAlbum?: number;
      ms?: number;
    }>;
    removeAssetsFromAlbum?: ( phUris: string[], album: string ) => Promise<{
      removed: number;
      requested: number;
    }>;
  };
};

// Where an imported device photo the app could not delete ends up, so the user
// can find them all in one place in Photos.
//
// This is the answer to a deletion that has stopped working. Deleting these
// photos from the Photos app works on the device where the app's own
// deleteAssets has been unanswered for days, so filing them into an album is
// what turns "1454 photos I can't get rid of" into a list the user can select
// and delete themselves. Adding to an album this app created asks the user for
// nothing, which is why it still goes through when the deletion doesn't.
//
// queuedDeletionAlbum.ts keeps it in step with what Photo Cleanup would
// delete as observations are created, faved and edited, and a deleted asset
// leaves every album it is in, so the album holds only what is left behind.
export const IMPORTED_ALBUM_TITLE = "Imported to iNaturalist";

// Files photos into the album. Never throws: this runs alongside a deletion
// and must not be able to stop one, and a photo that isn't filed is a smaller
// problem than a cleanup that fails because the filing did.
// Resolves null when the filing failed.
const addPhotosToImportedAlbum = async (
  photoUris: string[],
): Promise<{ added: number; alreadyIn: number } | null> => {
  if ( Platform.OS !== "ios" || !ImageCropper?.addAssetsToAlbum ) return null;
  const uris = [...new Set( photoUris.filter( uri => uri?.startsWith( "ph://" ) ) )];
  if ( uris.length === 0 ) return { added: 0, alreadyIn: 0 };
  try {
    const result = await ImageCropper.addAssetsToAlbum( uris, IMPORTED_ALBUM_TITLE );
    // Only worth a line when something was actually filed: a cleanup the user
    // opens twice would otherwise log a no-op every time.
    if ( result.added > 0 ) {
      logger.infoWithExtra( "imported_album_filed", {
        added: result.added,
        requested: result.requested,
        alreadyIn: result.alreadyIn,
        createdAlbum: result.createdAlbum ?? false,
        albums: result.albums ?? -1,
        inAlbum: result.inAlbum ?? -1,
        ms: result.ms ?? -1,
      } );
    }
    return { added: result.added, alreadyIn: result.alreadyIn };
  } catch ( error ) {
    logger.warnWithExtra( "imported_album_failed", {
      requested: uris.length,
      error: String( ( error as { message?: string } )?.message ?? error ),
    } );
    return null;
  }
};

// Takes photos that are no longer queued for deletion (their observation was
// faved) back out of the album. Never throws; resolves false on failure.
export const removePhotosFromImportedAlbum = async ( photoUris: string[] ): Promise<boolean> => {
  if ( Platform.OS !== "ios" || !ImageCropper?.removeAssetsFromAlbum ) return false;
  const uris = [...new Set( photoUris.filter( uri => uri?.startsWith( "ph://" ) ) )];
  if ( uris.length === 0 ) return true;
  try {
    const result = await ImageCropper.removeAssetsFromAlbum( uris, IMPORTED_ALBUM_TITLE );
    if ( result.removed > 0 ) {
      logger.infoWithExtra( "imported_album_unfiled", { ...result } );
    }
    return true;
  } catch ( error ) {
    logger.warnWithExtra( "imported_album_remove_failed", {
      requested: uris.length,
      error: String( ( error as { message?: string } )?.message ?? error ),
    } );
    return false;
  }
};

export default addPhotosToImportedAlbum;
