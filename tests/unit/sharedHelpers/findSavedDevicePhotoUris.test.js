import Observation from "realmModels/Observation";
import {
  findSavedDevicePhotoUris,
  recordUploadedDevicePhotoUris,
} from "sharedHelpers/duplicateUploadedDevicePhotos";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import { v4 as uuidv4 } from "uuid";

const saveObservationWithPhoto = originalDevicePhotoUri => Observation
  .saveLocalObservationForUpload( {
    uuid: uuidv4( ),
    observationPhotos: [{
      uuid: uuidv4( ),
      position: 0,
      originalDevicePhotoUri,
      photo: { uuid: uuidv4( ), url: "file:///local.jpg" },
    }],
  }, global.realm );

describe( "findSavedDevicePhotoUris", ( ) => {
  afterEach( ( ) => {
    safeRealmWrite( global.realm, ( ) => {
      global.realm.delete( global.realm.objects( "UploadedDevicePhotoUri" ) );
    }, "clearing uploaded device photo uris" );
  } );

  it( "finds photos on an observation and photos recorded as uploaded", async ( ) => {
    const onObservation = `ph://${uuidv4( )}`;
    const recorded = `ph://${uuidv4( )}`;
    const unsaved = `ph://${uuidv4( )}`;
    await saveObservationWithPhoto( onObservation );
    recordUploadedDevicePhotoUris( global.realm, [recorded] );

    expect( findSavedDevicePhotoUris( global.realm, [onObservation, recorded, unsaved] ) )
      .toEqual( new Set( [onObservation, recorded] ) );
  } );

  it( "finds a library photo an observation stored without its ph://", async ( ) => {
    const id = uuidv4( );
    await saveObservationWithPhoto( id );

    expect( findSavedDevicePhotoUris( global.realm, [`ph://${id}`] ) )
      .toEqual( new Set( [`ph://${id}`] ) );
  } );

  it( "finds a staged USB photo saved from another app container", async ( ) => {
    const name = `1700000000000_${uuidv4( )}.JPG`;
    const recordedName = `1700000000001_${uuidv4( )}.JPG`;
    await saveObservationWithPhoto( `file:///old/container/Documents/usbStaging/${name}` );
    recordUploadedDevicePhotoUris(
      global.realm,
      [`file:///old/container/Documents/usbStaging/${recordedName}`],
    );
    const now = n => `file:///new/container/Documents/usbStaging/${n}`;

    expect( findSavedDevicePhotoUris( global.realm, [now( name ), now( recordedName )] ) )
      .toEqual( new Set( [now( name ), now( recordedName )] ) );
  } );

  it( "finds nothing when asked about nothing", ( ) => {
    expect( findSavedDevicePhotoUris( global.realm, [null, undefined] ) ).toEqual( new Set( ) );
  } );
} );
