import filterExistingDevicePhotoUris from "sharedHelpers/existingDevicePhotoUris";
import findUnfavoritedDevicePhotoUris from "sharedHelpers/unfavoritedDevicePhotos";

// Stands in for the native PHAsset lookup; by default every URI still exists.
jest.mock( "sharedHelpers/existingDevicePhotoUris", ( ) => jest.fn(
  uris => Promise.resolve( uris ),
) );

const makeRealm = observations => ( {
  objects: ( ) => observations,
} );

const makeObservation = ( { faved, deviceUris = [], uuid } ) => ( {
  uuid,
  votes: faved
    ? [{ vote_scope: null }]
    : [],
  observationPhotos: deviceUris.map( uri => ( { originalDevicePhotoUri: uri } ) ),
} );

const makeCache = entries => new Map(
  entries.map( ( { uuid, faved } ) => [uuid, { uuid, observedAtMs: null, faved }] ),
);

beforeEach( ( ) => {
  filterExistingDevicePhotoUris.mockImplementation( uris => Promise.resolve( uris ) );
} );

describe( "findUnfavoritedDevicePhotoUris", ( ) => {
  it( "returns every stored URI of an unfavorited observation", async ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: false, deviceUris: ["ph://A1", "ph://A2"] } ),
    ] );

    expect( await findUnfavoritedDevicePhotoUris( realm ) ).toEqual( ["ph://A1", "ph://A2"] );
  } );

  it( "protects URIs stored on a favorited observation", async ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: false, deviceUris: ["ph://DELETE", "ph://SHARED"] } ),
      makeObservation( { faved: true, deviceUris: ["ph://KEEP", "ph://SHARED"] } ),
    ] );

    expect( await findUnfavoritedDevicePhotoUris( realm ) ).toEqual( ["ph://DELETE"] );
  } );

  it( "drops a stored URI whose photo is already gone from the library", async ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: false, deviceUris: ["ph://GONE", "ph://STILL_HERE"] } ),
    ] );
    filterExistingDevicePhotoUris.mockImplementation(
      uris => Promise.resolve( uris.filter( uri => uri === "ph://STILL_HERE" ) ),
    );

    expect( await findUnfavoritedDevicePhotoUris( realm ) ).toEqual( ["ph://STILL_HERE"] );
  } );

  it( "trusts the cache over stale Realm votes", async ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: false, deviceUris: ["ph://STALE"], uuid: "obs-1" } ),
    ] );

    const uris = await findUnfavoritedDevicePhotoUris(
      realm,
      makeCache( [{ uuid: "obs-1", faved: true }] ),
    );

    expect( uris ).toEqual( [] );
  } );
} );
