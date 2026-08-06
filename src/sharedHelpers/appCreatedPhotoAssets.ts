import { MMKV } from "react-native-mmkv";

// Photos-library assets this app itself added to the library — currently the
// USB card offload (UsbStorage.m saveImageToPhotos).
//
// Why this exists: PhotoKit presents its deletion confirmation for assets the
// app did not create, and deletes the app's own assets without one. That is
// the only documented way to delete without a prompt, and the prompt is what
// the deletion hangs are stuck on (see promptDeleteOriginalDevicePhotos.ts).
// PhotoKit offers no way to ask, after the fact, whether a given asset was
// ours — PHAsset.sourceType only separates the user library from shared and
// synced albums — so the identifier has to be recorded at creation time and
// kept here.

const store = new MMKV( { id: "app-created-photo-assets" } );

const IDENTIFIERS_KEY = "identifiers";
// Whether the no-confirmation deletion actually holds on this device. See
// recordAppCreatedDeletionTiming.
const EXEMPTION_KEY = "delete-exemption";

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

// The subset of uris we created, in the caller's own uri form so it can hand
// them straight back to the native deleter.
export const appCreatedPhotoUris = ( uris: string[] ): string[] => {
  const ours = new Set( readIdentifiers( ) );
  if ( ours.size === 0 ) return [];
  return uris.filter( uri => ours.has( basePhotoAssetId( uri ) ) );
};

// The no-confirmation deletion of app-created assets is documented PhotoKit
// behaviour, but it is behaviour we can only confirm by observing it: nothing
// reports whether an alert was presented. A transaction that needed no
// confirmation is a local database write and returns in well under a second;
// one the user had to notice, read and tap does not. Anything slower than this
// is taken as evidence it prompted, and the exemption as absent on this device.
//
// This was 10s, which is long enough for a quick tap on a real alert to be
// recorded as proof the exemption holds — and that verdict is what licenses
// splitting a mixed batch into two transactions, i.e. asking the user to
// confirm twice for one import. Two seconds still clears any plausible
// unprompted transaction, and the way it errs (a slow-but-exempt device stops
// splitting) costs nothing but a prompt the user was already getting.
const NO_CONFIRMATION_MAX_MS = 2_000;

// Only true once a transaction of ours has actually come back fast enough to
// have gone through without an alert.
export const isAppCreatedDeleteExemptionConfirmed = ( ): boolean => (
  store.getString( EXEMPTION_KEY ) === "yes"
);

// ms < 0 means the transaction never came back, which says nothing about
// whether it would have prompted — leave the verdict open for next time.
export const recordAppCreatedDeletionTiming = ( ms: number ) => {
  if ( ms < 0 ) return;
  store.set( EXEMPTION_KEY, ms < NO_CONFIRMATION_MAX_MS
    ? "yes"
    : "no" );
};
