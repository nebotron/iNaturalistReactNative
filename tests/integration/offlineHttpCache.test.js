import { fetchRemoteObservation } from "api/observations";
import inatjs from "inaturalistjs";
import { clearHttpCache, createCachedFetch } from "sharedHelpers/httpCache";
import remoteObservationParams from "sharedHelpers/remoteObservationParams";
import { fetchNotificationsPage } from "sharedHooks/useInfiniteNotificationsScroll";
import factory from "tests/factory";

// The point of this file is the real request the real client builds, so the
// usual inaturalistjs mock is exactly what must not be in the way.
jest.unmock( "inaturalistjs" );

const OPTS = { api_token: "token" };

const mockObservation = factory( "RemoteObservation", {
  comments: [factory( "RemoteComment" )],
} );
const mockUpdate = {
  id: 123,
  created_at: new Date( ).toISOString( ),
  comment: factory( "RemoteComment" ),
  comment_id: 7,
  notifier_type: "Comment",
  resource_uuid: mockObservation.uuid,
  viewed: false,
};

const json = body => new Response( JSON.stringify( body ), {
  status: 200,
  // What the API actually answers with on every route this reads
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-cache, no-store, must-revalidate",
  },
} );

const online = jest.fn( async url => (
  String( url ).includes( "/updates" )
    ? json( { results: [mockUpdate] } )
    : json( { results: [mockObservation] } )
) );

const goOffline = ( ) => {
  global.fetch = createCachedFetch( jest.fn( ( ) => Promise.reject(
    new TypeError( "Network request failed" ),
  ) ) );
};

const goOnline = ( ) => {
  online.mockClear( );
  global.fetch = createCachedFetch( online );
};

describe( "what a user was notified about, offline", ( ) => {
  beforeAll( ( ) => {
    inatjs.setConfig( { apiURL: "https://api.inaturalist.org/v2" } );
  } );

  beforeEach( ( ) => {
    clearHttpCache( );
    goOnline( );
  } );

  it( "replays the notifications list the last connection saw", async ( ) => {
    const params = { observations_by: "following" };
    const online1 = await fetchNotificationsPage( params, 1, OPTS, null );
    expect( online1[0].resource_uuid ).toEqual( mockObservation.uuid );

    goOffline( );
    const offline1 = await fetchNotificationsPage( params, 1, OPTS, null );

    expect( offline1[0].resource_uuid ).toEqual( mockObservation.uuid );
    expect( offline1[0].resource.uuid ).toEqual( mockObservation.uuid );
  } );

  it( "replays observation detail, which the client sends as a POST", async ( ) => {
    // The guard on the whole design: this field set is long enough that
    // inaturalistjs sends it as a POST with X-HTTP-Method-Override, which no
    // HTTP cache would keep for us.
    const [, init] = await ( async ( ) => {
      await fetchRemoteObservation( mockObservation.uuid, remoteObservationParams( ), OPTS );
      return online.mock.calls[0];
    } )( );
    expect( init.method ).toEqual( "post" );
    expect( init.headers["X-HTTP-Method-Override"] ).toEqual( "GET" );

    goOffline( );
    const cached = await fetchRemoteObservation(
      mockObservation.uuid,
      remoteObservationParams( ),
      OPTS,
    );

    expect( cached.uuid ).toEqual( mockObservation.uuid );
  } );

  it( "has nothing to replay for an observation never fetched", async ( ) => {
    goOffline( );

    await expect( fetchRemoteObservation(
      "never-fetched-uuid",
      remoteObservationParams( ),
      OPTS,
    ) ).rejects.toThrow( /Network request failed/ );
  } );
} );
