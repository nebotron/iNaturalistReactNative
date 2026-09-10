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
      ms?: number;
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
// It holds only what a cleanup left behind, because it can hold nothing else:
// a deleted asset leaves every album it is in, so filing the photos a cleanup
// is about to delete just empties the album again a second later.
export const IMPORTED_ALBUM_TITLE = "Imported to iNaturalist";

// Files photos into the album. Never throws: this runs alongside a deletion
// and must not be able to stop one, and a photo that isn't filed is a smaller
// problem than a cleanup that fails because the filing did.
const addPhotosToImportedAlbum = async ( photoUris: string[] ): Promise<number> => {
  if ( Platform.OS !== "ios" || !ImageCropper?.addAssetsToAlbum ) return 0;
  const uris = [...new Set( photoUris.filter( uri => uri?.startsWith( "ph://" ) ) )];
  if ( uris.length === 0 ) return 0;
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
        ms: result.ms ?? -1,
      } );
    }
    return result.added;
  } catch ( error ) {
    logger.warnWithExtra( "imported_album_failed", {
      requested: uris.length,
      error: String( ( error as { message?: string } )?.message ?? error ),
    } );
    return 0;
  }
};

export default addPhotosToImportedAlbum;
