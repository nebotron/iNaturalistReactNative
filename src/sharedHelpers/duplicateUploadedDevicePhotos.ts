import type { Asset } from "react-native-image-picker";
import type Realm from "realm";
import type { RealmObservation } from "realmModels/types";
import UploadedDevicePhotoUri from "realmModels/UploadedDevicePhotoUri";
import {
  getGalleryAssetDevicePhotoUri,
  normalizeDevicePhotoUri,
} from "sharedHelpers/getOriginalDevicePhotoUri";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";

export const getDevicePhotoUrisFromObservation = (
  observation: Pick<RealmObservation, "observationPhotos">,
): string[] => (
  ( observation.observationPhotos ?? [] )
    .map( obsPhoto => normalizeDevicePhotoUri( obsPhoto.originalDevicePhotoUri ) )
    .filter( ( uri ): uri is string => !!uri )
);

export const recordUploadedDevicePhotoUris = (
  realm: Realm,
  devicePhotoUris: string[],
): void => {
  const normalizedUris = devicePhotoUris
    .map( normalizeDevicePhotoUri )
    .filter( ( uri ): uri is string => !!uri );

  if ( normalizedUris.length === 0 ) {
    return;
  }

  safeRealmWrite( realm, ( ) => {
    normalizedUris.forEach( uri => {
      realm.create(
        UploadedDevicePhotoUri.schema.name,
        { uri, uploadedAt: new Date( ) },
        "modified",
      );
    } );
  }, "recording uploaded device photo URIs" );
};

// Undoes recordUploadedDevicePhotoUris for photos whose import turned out not
// to happen, so a photo that never made it into an observation isn't hidden
// from the picker forever. A photo an *earlier* observation already saved stays
// hidden regardless, since that observation still carries its device URI.
export const forgetUploadedDevicePhotoUris = (
  realm: Realm,
  devicePhotoUris: string[],
): void => {
  const normalizedUris = devicePhotoUris
    .map( normalizeDevicePhotoUri )
    .filter( ( uri ): uri is string => !!uri );

  if ( normalizedUris.length === 0 ) {
    return;
  }

  safeRealmWrite( realm, ( ) => {
    normalizedUris.forEach( uri => {
      const record = realm.objectForPrimaryKey( UploadedDevicePhotoUri.schema.name, uri );
      if ( record ) {
        realm.delete( record );
      }
    } );
  }, "forgetting uploaded device photo URIs" );
};

export const recordUploadedDevicePhotoUrisFromObservation = (
  realm: Realm,
  observation: Pick<RealmObservation, "observationPhotos">,
): void => {
  recordUploadedDevicePhotoUris(
    realm,
    getDevicePhotoUrisFromObservation( observation ),
  );
};

// A staged USB photo's path names the app container it was staged in, which
// changes across updates, so it matches by staged name, as devicePhotoKey does
const STAGED_NAME = /\/usbStaging\/([^/]+)$/;
const matchKey = ( uri: string ) => {
  const name = uri.match( STAGED_NAME )?.[1];
  return name
    ? `usbStaging/${name}`
    : uri;
};

// `field IN $0`, or-ed with an ENDSWITH per staged photo, and its arguments
const savedQuery = ( field: string, exact: string[], stagedSuffixes: string[] ) => {
  const clauses = [
    `${field} IN $0`,
    ...stagedSuffixes.map( ( _suffix, i ) => `${field} ENDSWITH $${i + 1}` ),
  ];
  return [clauses.join( " OR " ), exact, ...stagedSuffixes] as const;
};

// Which of these device photos are saved: on an observation in Realm, or
// recorded as uploaded. Asks Realm about just these, one query a table, run in
// Realm's own code, rather than reading every observation and record into JS,
// which with tens of thousands of photos held up opening the photo picker.
// Resolves the normalized URIs among these that are saved.
export const findSavedDevicePhotoUris = (
  realm: Realm,
  uris: ( string | null | undefined )[],
): Set<string> => {
  const wanted = new Map<string, string>( );
  uris.forEach( raw => {
    const uri = normalizeDevicePhotoUri( raw );
    if ( uri ) wanted.set( matchKey( uri ), uri );
  } );
  const saved = new Set<string>( );
  if ( wanted.size === 0 ) return saved;
  const exact: string[] = [];
  const stagedSuffixes: string[] = [];
  wanted.forEach( uri => {
    const name = uri.match( STAGED_NAME )?.[1];
    if ( name ) {
      stagedSuffixes.push( `/usbStaging/${name}` );
    } else {
      // Observations may store a library URI without its ph://
      exact.push( uri, uri.replace( /^ph:\/\//, "" ) );
    }
  } );
  const note = ( stored: string | null | undefined ) => {
    const uri = normalizeDevicePhotoUri( stored );
    const hit = uri && wanted.get( matchKey( uri ) );
    if ( hit ) saved.add( hit );
  };
  realm.objects<UploadedDevicePhotoUri>( UploadedDevicePhotoUri.schema.name )
    .filtered( ...savedQuery( "uri", exact, stagedSuffixes ) )
    .forEach( record => note( record.uri ) );
  realm.objects<RealmObservation>( "Observation" )
    .filtered( ...savedQuery(
      "ANY observationPhotos.originalDevicePhotoUri",
      exact,
      stagedSuffixes,
    ) )
    .forEach( observation => ( observation.observationPhotos ?? [] )
      .forEach( obsPhoto => note( obsPhoto.originalDevicePhotoUri ) ) );
  return saved;
};

// The same for a single photo, against a set the caller already has. An import
// that marks its photos one at a time as they land must not walk every saved
// observation once per photo to do it.
export function markDuplicatePhotoFromLibrary<T extends Asset>(
  previouslyUploadedUris: Set<string>,
  photo: { image: T },
  sourceAsset?: Asset,
): {
  image: T;
  isDuplicateUpload: boolean;
  originalDevicePhotoUri?: string;
} {
  const deviceUri = getGalleryAssetDevicePhotoUri( sourceAsset ?? photo.image );
  return {
    image: photo.image,
    isDuplicateUpload: !!( deviceUri && previouslyUploadedUris.has( deviceUri ) ),
    originalDevicePhotoUri: deviceUri ?? undefined,
  };
}

// Generic over the image so callers keep whatever they carry alongside the
// picker's own fields (e.g. the device asset's location) rather than having it
// typed away here.
export const markDuplicatePhotosFromLibrary = <T extends Asset>(
  realm: Realm,
  movedPhotos: { image: T }[],
  sourceAssets: Asset[] = [],
): {
  image: T;
  isDuplicateUpload: boolean;
  originalDevicePhotoUri?: string;
}[] => {
  const previouslyUploadedUris = findSavedDevicePhotoUris(
    realm,
    movedPhotos.map( ( photo, index ) => getGalleryAssetDevicePhotoUri(
      sourceAssets[index] ?? photo.image,
    ) ),
  );

  return movedPhotos.map( ( photo, index ) => markDuplicatePhotoFromLibrary(
    previouslyUploadedUris,
    photo,
    sourceAssets[index],
  ) );
};
