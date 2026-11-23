import Observation from "realmModels/Observation";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import factory from "tests/factory";

describe( "upsertRemoteObservations of an unchanged payload", ( ) => {
  it( "should not rewrite an observation from the same payload again", ( ) => {
    const mockRemoteObservation = factory( "RemoteObservation", {
      observation_photos: [factory( "RemoteObservationPhoto" )],
    } );
    Observation.upsertRemoteObservations( [mockRemoteObservation], global.realm );
    const create = jest.spyOn( global.realm, "create" );

    Observation.upsertRemoteObservations( [{ ...mockRemoteObservation }], global.realm );
    expect( create ).not.toHaveBeenCalled( );

    Observation.upsertRemoteObservations(
      [{ ...mockRemoteObservation, quality_grade: "research" }],
      global.realm,
    );
    expect( create ).toHaveBeenCalledTimes( 1 );
    create.mockRestore( );
    const obs = global.realm.objectForPrimaryKey( "Observation", mockRemoteObservation.uuid );
    expect( obs.quality_grade ).toEqual( "research" );
  } );

  it( "should write an unchanged payload again once the observation was deleted", ( ) => {
    const mockRemoteObservation = factory( "RemoteObservation" );
    Observation.upsertRemoteObservations( [mockRemoteObservation], global.realm );
    safeRealmWrite( global.realm, ( ) => {
      global.realm.delete(
        global.realm.objectForPrimaryKey( "Observation", mockRemoteObservation.uuid ),
      );
    }, "deleting observation in test" );

    Observation.upsertRemoteObservations( [mockRemoteObservation], global.realm );
    expect(
      global.realm.objectForPrimaryKey( "Observation", mockRemoteObservation.uuid ),
    ).not.toBeNull( );
  } );
} );

describe( "unchanged payloads across launches", ( ) => {
  // MMKV instances with the same id share their values, as on a device
  const stores = new Map( );
  class SharedMMKV {
    constructor( { id } ) {
      if ( !stores.has( id ) ) stores.set( id, new Map( ) );
      this.values = stores.get( id );
    }

    getString( key ) { return this.values.get( key ); }

    getNumber( key ) { return this.values.get( key ); }

    set( key, value ) { this.values.set( key, value ); }

    clearAll( ) { this.values.clear( ); }

    getAllKeys( ) { return [...this.values.keys( )]; }
  }

  // Loads the module afresh, as a new launch does: whatever it held only in
  // memory is gone, what it stored is still there.
  const launch = ( commit = "abc123" ) => {
    let withoutUnchanged;
    jest.isolateModules( ( ) => {
      jest.doMock( "react-native-mmkv", ( ) => ( { MMKV: SharedMMKV } ) );
      jest.doMock( "sharedHelpers/appCommit", ( ) => ( { __esModule: true, default: commit } ) );
      // eslint-disable-next-line global-require
      withoutUnchanged = require( "sharedHelpers/unchangedRemoteObservations" ).default;
    } );
    return withoutUnchanged;
  };
  const realm = {
    isInTransaction: false,
    objectForPrimaryKey: jest.fn( ( ) => ( {} ) ),
  };
  const payload = { uuid: "obs-1", quality_grade: "needs_id" };

  beforeEach( ( ) => stores.clear( ) );

  it( "skips a payload an earlier launch already wrote", ( ) => {
    const [toWrite, markWritten] = launch( )( [payload], realm );
    expect( toWrite ).toEqual( [payload] );
    markWritten( );

    expect( launch( )( [{ ...payload }], realm )[0] ).toEqual( [] );
  } );

  it( "writes everything again after an update to a new build", ( ) => {
    launch( "abc123" )( [payload], realm )[1]( );

    expect( launch( "def456" )( [payload], realm )[0] ).toEqual( [payload] );
  } );
} );
