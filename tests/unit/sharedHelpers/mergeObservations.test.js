import mergeObservations from "sharedHelpers/mergeObservations";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import useStore from "stores/useStore";
import faker from "tests/helpers/faker";

const photo = id => ( {
  uuid: faker.string.uuid( ),
  _synced_at: new Date( ),
  photo: { id, url: `https://example.com/${id}.jpg`, license_code: "cc-by" },
} );

describe( "mergeObservations", ( ) => {
  it( "moves photos into the target and defers deleting synced sources", ( ) => {
    const { realm } = global;
    const [target, synced, local] = safeRealmWrite( realm, ( ) => [
      { observationPhotos: [photo( 1 )] },
      {
        observationPhotos: [photo( 2 )], _synced_at: new Date( ), latitude: 1, longitude: 2,
      },
      { observationPhotos: [photo( 3 )] },
    ].map( obs => realm.create( "Observation", { uuid: faker.string.uuid( ), ...obs } ) ), "" );
    const [targetUuid, syncedUuid] = [target.uuid, synced.uuid];

    mergeObservations( realm, target, [synced, local] );

    const merged = realm.objectForPrimaryKey( "Observation", targetUuid );
    expect( merged.observationPhotos.map( op => op.photo.id ) ).toEqual( [1, 2, 3] );
    expect( merged.observationPhotos[1]._synced_at ).toBeNull( );
    expect( merged.observationPhotos[1].photo.license_code ).toEqual( "cc-by" );
    expect( merged.latitude ).toEqual( 1 );
    expect( realm.objects( "Observation" ).length ).toEqual( 1 );
    expect( useStore.getState( ).mergeDeletions )
      .toEqual( [{ source: syncedUuid, target: targetUuid }] );
  } );
} );
