import classifyDevicePhotoUris from "sharedHelpers/unfavoritedDevicePhotos";

const makeRealm = observations => ( {
  objects: ( ) => observations,
} );

const makeObservation = ( {
  faved, deviceUris = [], uuid, uploadedUris = [],
} ) => ( {
  uuid,
  votes: faved
    ? [{ vote_scope: null }]
    : [],
  observationPhotos: deviceUris.map( uri => ( {
    originalDevicePhotoUri: uri,
    _synced_at: uploadedUris.includes( uri )
      ? new Date( )
      : null,
  } ) ),
} );

const makeCache = entries => new Map(
  entries.map( ( { uuid, faved } ) => [uuid, { uuid, observedAtMs: null, faved }] ),
);

describe( "classifyDevicePhotoUris", ( ) => {
  it( "returns every stored URI of an unfavorited observation", ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: false, deviceUris: ["ph://A1", "ph://A2"] } ),
    ] );

    expect( classifyDevicePhotoUris( realm ).unfavorited ).toEqual( ["ph://A1", "ph://A2"] );
  } );

  it( "protects URIs stored on a favorited observation", ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: false, deviceUris: ["ph://DELETE", "ph://SHARED"] } ),
      makeObservation( { faved: true, deviceUris: ["ph://KEEP", "ph://SHARED"] } ),
    ] );

    expect( classifyDevicePhotoUris( realm ).unfavorited ).toEqual( ["ph://DELETE"] );
  } );

  it( "lists uploaded photos, faved or not, as uploaded or removed", ( ) => {
    const realm = makeRealm( [
      makeObservation( {
        faved: false, deviceUris: ["ph://UP", "ph://PENDING"], uploadedUris: ["ph://UP"],
      } ),
      makeObservation( {
        faved: true, deviceUris: ["ph://FAVED_UP"], uploadedUris: ["ph://FAVED_UP"],
      } ),
    ] );

    expect( classifyDevicePhotoUris( realm ).uploadedOrRemoved )
      .toEqual( ["ph://UP", "ph://FAVED_UP"] );
  } );

  it( "trusts the cache over stale Realm votes", ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: false, deviceUris: ["ph://STALE"], uuid: "obs-1" } ),
    ] );

    const { unfavorited } = classifyDevicePhotoUris(
      realm,
      makeCache( [{ uuid: "obs-1", faved: true }] ),
    );

    expect( unfavorited ).toEqual( [] );
  } );
} );
