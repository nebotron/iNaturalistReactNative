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
