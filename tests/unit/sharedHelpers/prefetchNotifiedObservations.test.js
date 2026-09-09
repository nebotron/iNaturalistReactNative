import { prefetch } from "@candlefinance/faster-image";
import NetInfo from "@react-native-community/netinfo";
import { fetchRemoteObservation } from "api/observations";
import prefetchNotifiedObservations, {
  MAX_PREFETCHED_OBSERVATIONS,
} from "sharedHelpers/prefetchNotifiedObservations";
import remoteObservationParams from "sharedHelpers/remoteObservationParams";

jest.mock( "api/observations", ( ) => ( {
  fetchRemoteObservation: jest.fn( ),
} ) );

const SQUARE_URL = "https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpeg";
const LARGE_URL = "https://inaturalist-open-data.s3.amazonaws.com/photos/1/large.jpeg";

const OPTS = { api_token: "token" };

// The module remembers what it fetched for the life of the session, so every
// test needs notification ids of its own.
let nextId = 0;
const notification = ( uuid, overrides = {} ) => {
  nextId += 1;
  return { id: nextId, resource_uuid: uuid, ...overrides };
};

describe( "prefetchNotifiedObservations", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    NetInfo.fetch.mockResolvedValue( { isConnected: true } );
    fetchRemoteObservation.mockResolvedValue( { uuid: "obs-uuid" } );
  } );

  it( "asks for exactly what ObsDetails will ask for", async ( ) => {
    await prefetchNotifiedObservations( [notification( "obs-1" )], OPTS );

    expect( fetchRemoteObservation ).toHaveBeenCalledWith(
      "obs-1",
      remoteObservationParams( ),
      expect.anything( ),
    );
  } );

  it( "fetches nothing with no connection, since only the cache could answer", async ( ) => {
    NetInfo.fetch.mockResolvedValue( { isConnected: false } );

    await prefetchNotifiedObservations( [notification( "obs-2" )], OPTS );

    expect( fetchRemoteObservation ).not.toHaveBeenCalled( );
  } );

  it( "asks for each observation once, however many notifications point at it", async ( ) => {
    const uuid = "obs-3";

    await prefetchNotifiedObservations(
      [notification( uuid ), notification( uuid )],
      OPTS,
    );

    expect( fetchRemoteObservation ).toHaveBeenCalledTimes( 1 );
  } );

  it( "does not fetch the same notification's observation twice", async ( ) => {
    const notifications = [notification( "obs-4" )];

    await prefetchNotifiedObservations( notifications, OPTS );
    await prefetchNotifiedObservations( notifications, OPTS );

    expect( fetchRemoteObservation ).toHaveBeenCalledTimes( 1 );
  } );

  it( "fetches again when a new notification arrives for the same observation", async ( ) => {
    const uuid = "obs-5";

    await prefetchNotifiedObservations( [notification( uuid )], OPTS );
    await prefetchNotifiedObservations( [notification( uuid )], OPTS );

    expect( fetchRemoteObservation ).toHaveBeenCalledTimes( 2 );
  } );

  it( "only prefetches the most recent notifications", async ( ) => {
    const notifications = Array.from(
      { length: MAX_PREFETCHED_OBSERVATIONS + 5 },
      ( _, i ) => notification( `obs-capped-${i}` ),
    );

    await prefetchNotifiedObservations( notifications, OPTS );

    expect( fetchRemoteObservation ).toHaveBeenCalledTimes( MAX_PREFETCHED_OBSERVATIONS );
  } );

  it( "warms both sizes the notified observation's photo is shown at", async ( ) => {
    await prefetchNotifiedObservations(
      [notification( "obs-6", {
        resource: { observation_photos: [{ photo: { url: SQUARE_URL } }] },
      } )],
      OPTS,
    );

    expect( prefetch ).toHaveBeenCalledWith( [SQUARE_URL, LARGE_URL] );
  } );
} );
