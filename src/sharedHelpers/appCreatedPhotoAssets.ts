import { MMKV } from "react-native-mmkv";

// Photos-library assets this app itself added to the library — currently the
// USB card offload (UsbStorage.m saveImageToPhotos).
//
// PhotoKit offers no way to ask, after the fact, whether a given asset was
// ours — PHAsset.sourceType only separates the user library from shared and
// synced albums — so the identifier has to be recorded at creation time and
// kept here.
//
// This used to decide how a deletion was split: our assets in a consent-free
// transaction, everything else in a prompted one. Deletions are a single
// transaction now (see deletePhotoAssets in ImageCropper.m), so what is left
// is the record itself — what the app put in the library, pruned as those
// assets are deleted.

const store = new MMKV( { id: "app-created-photo-assets" } );

const IDENTIFIERS_KEY = "identifiers";
// A card offload is tens to a few hundred photos at a time, and identifiers
// are pruned as they're deleted, so this only bounds pathological growth.
const MAX_TRACKED = 5000;

// fetchAssetsWithLocalIdentifiers matches with or without the "/L0/001"
// suffix, but a returned localIdentifier always carries one. Compare on the
// UUID ahead of the first slash, as ImageCropper.m does.
export const basePhotoAssetId = ( uri: string ): string => {
  const identifier = uri.startsWith( "ph://" )
    ? uri.slice( 5 )
    : uri;
  const slash = identifier.indexOf( "/" );
  return slash === -1
    ? identifier
    : identifier.slice( 0, slash );
};

const readIdentifiers = ( ): string[] => {
  const raw = store.getString( IDENTIFIERS_KEY );
  if ( !raw ) return [];
  try {
    const parsed = JSON.parse( raw );
    return Array.isArray( parsed )
      ? parsed.filter( ( id ): id is string => typeof id === "string" )
      : [];
  } catch {
    return [];
  }
};

const writeIdentifiers = ( identifiers: string[] ) => store.set(
  IDENTIFIERS_KEY,
  // Keep the newest when trimming: the oldest are the likeliest to have been
  // deleted already, by us or by the user in the Photos app.
  JSON.stringify( identifiers.slice( -MAX_TRACKED ) ),
);

export const recordAppCreatedPhotoAssets = ( localIdentifiers: string[] ) => {
  const added = localIdentifiers
    .filter( Boolean )
    .map( basePhotoAssetId );
  if ( added.length === 0 ) return;
  writeIdentifiers( [...new Set( [...readIdentifiers( ), ...added] )] );
};

export const forgetAppCreatedPhotoAssets = ( uris: string[] ) => {
  if ( uris.length === 0 ) return;
  const gone = new Set( uris.map( basePhotoAssetId ) );
  const kept = readIdentifiers( ).filter( id => !gone.has( id ) );
  writeIdentifiers( kept );
};
