import * as Exify from "@lodev09/react-native-exify";
import Observation from "realmModels/Observation";
import {
  applyLocationToDevicePhotoLibrary,
  autoApplyTrackedLocationIfMissing,
} from "sharedHelpers/applyTrackedLocationToPhotos";
import saveObservation, { awaitObservationSaveFinished } from "sharedHelpers/saveObservation";

jest.mock( "sharedHelpers/applyTrackedLocationToPhotos", ( ) => ( {
  applyLocationToDevicePhotoLibrary: jest.fn( ),
  autoApplyTrackedLocationIfMissing: jest.fn( ),
} ) );

jest.mock( "@lodev09/react-native-exify", ( ) => ( { write: jest.fn( ) } ) );

const realm = { isClosed: false };
const observation = { uuid: "obs-1", latitude: 1, longitude: 2 };

// A Photos library write that finishes only when the test says so
const deferred = ( ) => {
  let resolve;
  const promise = new Promise( r => { resolve = r; } );
  return { promise, resolve };
};

describe( "saveObservation with the location in the background", ( ) => {
  beforeEach( ( ) => {
    jest.spyOn( Observation, "saveLocalObservationForUpload" )
      .mockResolvedValue( { ...observation, isValid: ( ) => true } );
    autoApplyTrackedLocationIfMissing.mockResolvedValue( false );
  } );

  afterEach( ( ) => jest.restoreAllMocks( ) );

  it( "returns once the observation is in Realm", async ( ) => {
    const write = deferred( );
    applyLocationToDevicePhotoLibrary.mockReturnValue( write.promise );
    Exify.write.mockReturnValue( write.promise );
    const saved = await saveObservation( observation, ["ph://1"], realm, {
      locationInBackground: true,
    } );
    expect( saved.uuid ).toBe( "obs-1" );
    expect( autoApplyTrackedLocationIfMissing ).not.toHaveBeenCalled( );

    let finished = false;
    awaitObservationSaveFinished( "obs-1" ).then( ( ) => { finished = true; } );
    await Promise.resolve( );
    expect( finished ).toBe( false );

    write.resolve( );
    await awaitObservationSaveFinished( "obs-1" );
    expect( autoApplyTrackedLocationIfMissing ).toHaveBeenCalled( );
  } );

  it( "waits for the location by default", async ( ) => {
    applyLocationToDevicePhotoLibrary.mockResolvedValue( true );
    Exify.write.mockResolvedValue( true );
    await saveObservation( observation, ["ph://1"], realm );
    expect( autoApplyTrackedLocationIfMissing ).toHaveBeenCalled( );
  } );

  it( "finishes the save even when writing the location fails", async ( ) => {
    applyLocationToDevicePhotoLibrary.mockRejectedValue( new Error( "denied" ) );
    Exify.write.mockRejectedValue( new Error( "denied" ) );
    await saveObservation( observation, ["ph://1"], realm, { locationInBackground: true } );
    await expect( awaitObservationSaveFinished( "obs-1" ) ).resolves.toBeUndefined( );
    expect( autoApplyTrackedLocationIfMissing ).toHaveBeenCalled( );
  } );
} );
