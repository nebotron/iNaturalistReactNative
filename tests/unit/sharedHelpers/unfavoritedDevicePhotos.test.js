import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import findUnfavoritedDevicePhotoDays from "sharedHelpers/unfavoritedDevicePhotos";

// Build a Realm-like collection whose forEach iterates the given observations.
const makeRealm = observations => ( {
  objects: ( ) => ( {
    forEach: cb => observations.forEach( cb ),
  } ),
} );

const obs = ( uri, overrides = {} ) => ( {
  votes: [],
  time_observed_at: "2026-07-16T12:00:00Z",
  observationPhotos: [{ originalDevicePhotoUri: uri }],
  ...overrides,
} );

// Mock a device library that returns the given ph:// ids across one or more
// pages, mimicking CameraRoll.getPhotos cursor pagination.
const mockLibrary = pages => {
  let call = 0;
  CameraRoll.getPhotos.mockImplementation( ( ) => {
    const ids = pages[call] ?? [];
    const hasNext = call < pages.length - 1;
    call += 1;
    return Promise.resolve( {
      page_info: { end_cursor: `cursor-${call}`, has_next_page: hasNext },
      edges: ids.map( id => ( { node: { id, image: { uri: `ph://${id}` } } } ) ),
    } );
  } );
};

describe( "findUnfavoritedDevicePhotoDays", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
  } );

  it( "omits photos already deleted from the device library", async ( ) => {
    mockLibrary( [["EXISTS"]] );
    const realm = makeRealm( [obs( "ph://EXISTS" ), obs( "ph://DELETED" )] );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    const uris = days.flatMap( d => d.uris );
    expect( uris ).toContain( "ph://EXISTS" );
    expect( uris ).not.toContain( "ph://DELETED" );
  } );

  it( "finds older photos across multiple library pages", async ( ) => {
    // OLD only appears on the second page; a single-page scan would wrongly
    // treat it as deleted.
    mockLibrary( [["NEW"], ["OLD"]] );
    const realm = makeRealm( [obs( "ph://OLD" ), obs( "ph://NEW" )] );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    const uris = days.flatMap( d => d.uris );
    expect( uris ).toEqual( expect.arrayContaining( ["ph://OLD", "ph://NEW"] ) );
  } );

  it( "skips favorited observations", async ( ) => {
    mockLibrary( [["FAVED"]] );
    const realm = makeRealm( [
      obs( "ph://FAVED", { votes: [{ vote_scope: null }] } ),
    ] );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    expect( days.flatMap( d => d.uris ) ).toEqual( [] );
  } );

  it( "does not filter when the library cannot be read", async ( ) => {
    CameraRoll.getPhotos.mockRejectedValue( new Error( "denied" ) );
    const realm = makeRealm( [obs( "ph://KEEP" )] );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    expect( days.flatMap( d => d.uris ) ).toContain( "ph://KEEP" );
  } );
} );
