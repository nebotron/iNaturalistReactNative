import combineObservations from "sharedHelpers/combineObservations";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";

const createObs = ( uuid, photoUrl, extra = {} ) => safeRealmWrite( global.realm, ( ) => (
  global.realm.create( "Observation", {
    uuid,
    observationPhotos: [{ uuid: `${uuid}-photo`, photo: { url: photoUrl }, position: 0 }],
    ...extra,
  } )
), "creating observation for combineObservations test" );

describe( "combineObservations", ( ) => {
  it( "moves photos onto the first observation and deletes the others", async ( ) => {
    createObs( "combine-a", "https://example.com/a.jpg" );
    createObs( "combine-b", "https://example.com/b.jpg", { latitude: 1, longitude: 2 } );

    const keptUuid = await combineObservations( global.realm, ["combine-a", "combine-b"] );

    expect( keptUuid ).toEqual( "combine-a" );
    expect( global.realm.objectForPrimaryKey( "Observation", "combine-b" ) ).toBeNull( );
    const kept = global.realm.objectForPrimaryKey( "Observation", "combine-a" );
    expect( kept.observationPhotos.map( op => op.photo.url ) ).toEqual( [
      "https://example.com/a.jpg",
      "https://example.com/b.jpg",
    ] );
    expect( kept.observationPhotos[1].position ).toEqual( 1 );
    expect( kept.latitude ).toEqual( 1 );
  } );
} );
