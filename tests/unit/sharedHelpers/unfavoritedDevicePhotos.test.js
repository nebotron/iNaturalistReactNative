import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import findUnfavoritedDevicePhotoDays from "sharedHelpers/unfavoritedDevicePhotos";

// Fixed instants (ms) used across the fixtures below.
const UNFAV_TIME = Date.UTC( 2026, 6, 16, 12, 0, 0 );
const FAV_TIME = Date.UTC( 2026, 6, 10, 9, 0, 0 );

const makeRealm = observations => ( {
  objects: ( ) => observations,
} );

const makeObservation = ( { faved, timeMs, deviceUris = [] } ) => ( {
  time_observed_at: new Date( timeMs ).toISOString( ),
  votes: faved
    ? [{ vote_scope: null }]
    : [],
  observationPhotos: deviceUris.map( uri => ( { originalDevicePhotoUri: uri } ) ),
} );

const mockLibrary = nodes => {
  CameraRoll.getPhotos.mockResolvedValueOnce( {
    page_info: { has_next_page: false, end_cursor: null },
    edges: nodes.map( ( { id, timeMs } ) => ( {
      node: {
        id,
        timestamp: timeMs / 1000,
        image: { uri: `ph://${id}` },
      },
    } ) ),
  } );
};

const flatUris = days => days.flatMap( day => day.uris );

beforeEach( ( ) => {
  CameraRoll.getPhotos.mockReset( );
} );

describe( "findUnfavoritedDevicePhotoDays", ( ) => {
  it( "matches a photo by its exact stored device URI", async ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: false, timeMs: UNFAV_TIME, deviceUris: ["ph://EXACT"] } ),
    ] );
    mockLibrary( [{ id: "EXACT", timeMs: UNFAV_TIME }] );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    expect( flatUris( days ) ).toContain( "ph://EXACT" );
  } );

  it( "matches a legacy photo with no stored URI by exact capture time", async ( ) => {
    const realm = makeRealm( [
      // Legacy observation: unfavorited, no device URI stored.
      makeObservation( { faved: false, timeMs: UNFAV_TIME } ),
    ] );
    mockLibrary( [{ id: "LEGACY", timeMs: UNFAV_TIME }] );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    expect( flatUris( days ) ).toContain( "ph://LEGACY" );
  } );

  it( "does not match a photo taken a second away (zero tolerance)", async ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: false, timeMs: UNFAV_TIME } ),
    ] );
    mockLibrary( [{ id: "OFF_BY_ONE", timeMs: UNFAV_TIME + 1000 }] );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    expect( flatUris( days ) ).not.toContain( "ph://OFF_BY_ONE" );
  } );

  it( "protects photos whose capture time matches a favorited observation", async ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: false, timeMs: UNFAV_TIME } ),
      makeObservation( { faved: true, timeMs: FAV_TIME } ),
    ] );
    mockLibrary( [
      { id: "KEEP", timeMs: FAV_TIME },
      { id: "DELETE", timeMs: UNFAV_TIME },
    ] );

    const days = await findUnfavoritedDevicePhotoDays( realm );
    const uris = flatUris( days );

    expect( uris ).toContain( "ph://DELETE" );
    expect( uris ).not.toContain( "ph://KEEP" );
  } );

  it( "ignores photos that don't line up with any observation", async ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: false, timeMs: UNFAV_TIME } ),
    ] );
    mockLibrary( [{ id: "UNRELATED", timeMs: UNFAV_TIME + 10 * 60 * 1000 }] );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    expect( flatUris( days ) ).not.toContain( "ph://UNRELATED" );
  } );

  it( "doesn't double-count a photo whose stored URI is stale (e.g. after a "
    + "device restore reassigned local identifiers) alongside its rescanned match", async ( ) => {
    const realm = makeRealm( [
      makeObservation( {
        faved: false,
        timeMs: UNFAV_TIME,
        deviceUris: ["ph://STALE_ID"],
      } ),
    ] );
    // The physical photo now lives under a new identifier; the library scan
    // only ever sees CURRENT_ID, never STALE_ID.
    mockLibrary( [{ id: "CURRENT_ID", timeMs: UNFAV_TIME }] );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    expect( flatUris( days ) ).toEqual( ["ph://CURRENT_ID"] );
  } );

  it( "returns nothing when there are no unfavorited observations", async ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: true, timeMs: FAV_TIME, deviceUris: ["ph://FAVED"] } ),
    ] );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    expect( days ).toEqual( [] );
    expect( CameraRoll.getPhotos ).not.toHaveBeenCalled( );
  } );
} );
