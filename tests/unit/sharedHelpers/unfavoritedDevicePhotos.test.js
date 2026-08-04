import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import { NativeModules } from "react-native";
import filterExistingDevicePhotoUris from "sharedHelpers/existingDevicePhotoUris";
import findUnfavoritedDevicePhotoDays, {
  prefetchDeviceAssets,
} from "sharedHelpers/unfavoritedDevicePhotos";

// Stands in for the native PHAsset lookup; by default every URI still exists.
jest.mock( "sharedHelpers/existingDevicePhotoUris", ( ) => jest.fn(
  uris => Promise.resolve( uris ),
) );

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
  filterExistingDevicePhotoUris.mockImplementation( uris => Promise.resolve( uris ) );
} );

// The native matcher does the same job in one call, returning only the assets
// whose capture second is one of the ones it was asked about.
describe( "findUnfavoritedDevicePhotoDays with the native library matcher", ( ) => {
  const originalImageCropper = NativeModules.ImageCropper;
  let photoAssetsMatchingCaptureTimes;

  const mockNativeLibrary = nodes => {
    photoAssetsMatchingCaptureTimes.mockImplementation( captureTimesMs => {
      const wanted = new Set( captureTimesMs );
      const matching = nodes.filter( ( { timeMs } ) => wanted.has( timeMs ) );
      return Promise.resolve( {
        uris: matching.map( ( { id } ) => `ph://${id}` ),
        timestamps: matching.map( ( { timeMs } ) => timeMs ),
        scanned: nodes.length,
      } );
    } );
  };

  beforeEach( ( ) => {
    photoAssetsMatchingCaptureTimes = jest.fn( );
    NativeModules.ImageCropper = { photoAssetsMatchingCaptureTimes };
  } );

  afterEach( ( ) => {
    NativeModules.ImageCropper = originalImageCropper;
  } );

  it( "matches without paging the library through CameraRoll", async ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: false, timeMs: UNFAV_TIME } ),
      makeObservation( { faved: true, timeMs: FAV_TIME } ),
    ] );
    mockNativeLibrary( [
      { id: "DELETE", timeMs: UNFAV_TIME },
      { id: "FAVED", timeMs: FAV_TIME },
      { id: "UNRELATED", timeMs: UNFAV_TIME + 60 * 1000 },
    ] );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    expect( flatUris( days ) ).toEqual( ["ph://DELETE"] );
    expect( CameraRoll.getPhotos ).not.toHaveBeenCalled( );
  } );

  it( "falls back to CameraRoll when the native matcher can't answer", async ( ) => {
    photoAssetsMatchingCaptureTimes.mockRejectedValue( new Error( "not granted" ) );
    const realm = makeRealm( [makeObservation( { faved: false, timeMs: UNFAV_TIME } )] );
    mockLibrary( [{ id: "DELETE", timeMs: UNFAV_TIME }] );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    expect( flatUris( days ) ).toEqual( ["ph://DELETE"] );
  } );

  // The prefetch runs against the last synced observations, so the sync that
  // follows it can turn up times it never asked the library about.
  it( "tops up a prefetched scan with the times the sync added", async ( ) => {
    const NEW_TIME = UNFAV_TIME + 24 * 60 * 60 * 1000;
    mockNativeLibrary( [
      { id: "OLD", timeMs: UNFAV_TIME },
      { id: "NEW", timeMs: NEW_TIME },
    ] );
    // The prefetch only knows the observation Realm already had.
    const scan = prefetchDeviceAssets(
      makeRealm( [makeObservation( { faved: false, timeMs: UNFAV_TIME } )] ),
    );
    const realm = makeRealm( [
      makeObservation( { faved: false, timeMs: UNFAV_TIME } ),
      makeObservation( { faved: false, timeMs: NEW_TIME } ),
    ] );

    const days = await findUnfavoritedDevicePhotoDays( realm, scan );

    expect( flatUris( days ).sort( ) ).toEqual( ["ph://NEW", "ph://OLD"] );
    expect( photoAssetsMatchingCaptureTimes ).toHaveBeenCalledTimes( 2 );
    expect( photoAssetsMatchingCaptureTimes.mock.calls[1][0] ).toEqual( [NEW_TIME] );
  } );
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

  it( "drops a stored URI whose photo is already gone from the library, so it "
    + "can't show as a blank thumbnail or pad the delete count", async ( ) => {
    const realm = makeRealm( [
      makeObservation( {
        faved: false,
        timeMs: UNFAV_TIME,
        deviceUris: ["ph://DELETED_ALREADY", "ph://STILL_HERE"],
      } ),
    ] );
    // Neither stored URI turns up in the scan, so both reach the exact-match
    // fallback; only one of them still resolves to an asset.
    mockLibrary( [] );
    filterExistingDevicePhotoUris.mockImplementation(
      uris => Promise.resolve( uris.filter( uri => uri === "ph://STILL_HERE" ) ),
    );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    expect( flatUris( days ) ).toEqual( ["ph://STILL_HERE"] );
  } );

  it( "returns no days when every matching photo is already gone", async ( ) => {
    const realm = makeRealm( [
      makeObservation( {
        faved: false,
        timeMs: UNFAV_TIME,
        deviceUris: ["ph://DELETED_ALREADY"],
      } ),
    ] );
    mockLibrary( [] );
    filterExistingDevicePhotoUris.mockResolvedValue( [] );

    const days = await findUnfavoritedDevicePhotoDays( realm );

    expect( days ).toEqual( [] );
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

// Realm only holds the most recent page of remote observations, so everything
// older is only visible through the shared cache (see userObservationsCache.ts).
describe( "findUnfavoritedDevicePhotoDays with the shared observations cache", ( ) => {
  const makeCache = entries => new Map(
    entries.map( ( { uuid, timeMs, faved } ) => [
      uuid,
      {
        uuid, observedAtMs: timeMs, faved, researchGrade: false, taxonId: null, rankLevel: null,
      },
    ] ),
  );

  it( "protects a photo whose observation was favorited outside Realm", async ( ) => {
    const realm = makeRealm( [
      makeObservation( { faved: false, timeMs: UNFAV_TIME } ),
    ] );
    mockLibrary( [
      { id: "OLD_FAVE", timeMs: FAV_TIME },
      { id: "DELETE", timeMs: UNFAV_TIME },
    ] );

    const days = await findUnfavoritedDevicePhotoDays(
      realm,
      undefined,
      makeCache( [{ uuid: "old", timeMs: FAV_TIME, faved: true }] ),
    );
    const uris = flatUris( days );

    expect( uris ).toContain( "ph://DELETE" );
    expect( uris ).not.toContain( "ph://OLD_FAVE" );
  } );

  it( "finds a photo whose unfavorited observation is only in the cache", async ( ) => {
    const realm = makeRealm( [] );
    mockLibrary( [{ id: "OLD_UNFAVED", timeMs: UNFAV_TIME }] );

    const days = await findUnfavoritedDevicePhotoDays(
      realm,
      undefined,
      makeCache( [{ uuid: "old", timeMs: UNFAV_TIME, faved: false }] ),
    );

    expect( flatUris( days ) ).toContain( "ph://OLD_UNFAVED" );
  } );

  // Realm's votes are whatever the last sync happened to write; the cache is
  // reconciled with the server on every open.
  it( "trusts the cache over stale Realm votes for the same observation", async ( ) => {
    const realm = makeRealm( [
      {
        ...makeObservation( { faved: false, timeMs: UNFAV_TIME, deviceUris: ["ph://STALE"] } ),
        uuid: "obs-1",
      },
    ] );
    mockLibrary( [{ id: "STALE", timeMs: UNFAV_TIME }] );

    const days = await findUnfavoritedDevicePhotoDays(
      realm,
      undefined,
      makeCache( [{ uuid: "obs-1", timeMs: UNFAV_TIME, faved: true }] ),
    );

    expect( days ).toEqual( [] );
  } );
} );
