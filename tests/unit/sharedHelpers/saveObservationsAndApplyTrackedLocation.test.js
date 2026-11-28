import Observation from "realmModels/Observation";
import {
  saveObservationsAndApplyTrackedLocation,
} from "sharedHelpers/applyTrackedLocationToPhotos";

jest.mock( "sharedHelpers/locationHistoryTracker", ( ) => ( {
  drainTrackedLocationFixes: jest.fn( ( ) => Promise.resolve( ) ),
} ) );

jest.mock( "@lodev09/react-native-exify", ( ) => ( { write: jest.fn( ) } ) );

const observedAt = new Date( "2026-11-27T10:00:00" );
const trackedPoint = {
  latitude: 37.5,
  longitude: -122.25,
  accuracy: 8,
  recordedAt: observedAt,
};

// Stands in for Realm: holds what was saved, so the test can read back what an
// observation looked like the moment it was first written.
const makeRealm = ( ) => {
  const saved = {};
  return {
    saved,
    objects: ( ) => ( { sorted: ( ) => [trackedPoint] } ),
    objectForPrimaryKey: ( _type, uuid ) => saved[uuid]?.live,
    beginTransaction: ( ) => {},
    commitTransaction: ( ) => {},
    cancelTransaction: ( ) => {},
    isInTransaction: false,
    isClosed: false,
  };
};

describe( "saveObservationsAndApplyTrackedLocation", ( ) => {
  let realm;

  beforeEach( ( ) => {
    realm = makeRealm( );
    jest.spyOn( Observation, "saveLocalObservationForUpload" )
      .mockImplementation( async obs => {
        const live = { ...obs, observationPhotos: [] };
        realm.saved[obs.uuid] = { firstSave: { ...obs }, live };
        return live;
      } );
  } );

  afterEach( ( ) => jest.restoreAllMocks( ) );

  it( "saves an observation with its tracked location already set", async ( ) => {
    const result = await saveObservationsAndApplyTrackedLocation( [{
      uuid: "no-gps",
      observed_on_string: "2026-11-27T10:00:00",
    }], realm );

    expect( realm.saved["no-gps"].firstSave ).toEqual( expect.objectContaining( {
      latitude: 37.5,
      longitude: -122.25,
      positional_accuracy: 8,
    } ) );
    expect( result["no-gps"] ).toEqual( expect.objectContaining( {
      latitude: 37.5,
      longitude: -122.25,
    } ) );
  } );

  it( "leaves an observation's own location alone", async ( ) => {
    const result = await saveObservationsAndApplyTrackedLocation( [{
      uuid: "has-gps",
      latitude: 1,
      longitude: 2,
      observed_on_string: "2026-11-27T10:00:00",
    }], realm );

    expect( realm.saved["has-gps"].firstSave ).toEqual( expect.objectContaining( {
      latitude: 1,
      longitude: 2,
    } ) );
    expect( result ).toEqual( {} );
  } );

  it( "saves an observation with no matching tracked point", async ( ) => {
    const result = await saveObservationsAndApplyTrackedLocation( [{
      uuid: "too-old",
      observed_on_string: "2020-01-01T10:00:00",
    }], realm );

    expect( realm.saved["too-old"].firstSave.latitude ).toBeUndefined( );
    expect( result ).toEqual( {} );
  } );
} );
