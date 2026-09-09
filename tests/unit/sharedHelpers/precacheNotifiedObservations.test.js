import { prefetch } from "@candlefinance/faster-image";
import { fetchRemoteObservations } from "api/observations";
import {
  clearNotificationsCache,
  getCachedObservation,
} from "sharedHelpers/notificationsCache";
import precacheNotifiedObservations, {
  MAX_PRECACHED_OBSERVATIONS,
} from "sharedHelpers/precacheNotifiedObservations";

jest.mock( "api/observations", ( ) => ( {
  fetchRemoteObservations: jest.fn( ),
} ) );

const SQUARE_URL = "https://inaturalist-open-data.s3.amazonaws.com/photos/1/square.jpeg";
const LARGE_URL = "https://inaturalist-open-data.s3.amazonaws.com/photos/1/large.jpeg";

const observationWithPhoto = uuid => ( {
  uuid,
  observation_photos: [{ photo: { url: SQUARE_URL } }],
} );

describe( "precacheNotifiedObservations", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    clearNotificationsCache( );
  } );

  it( "does not hit the API when there are no notifications", async ( ) => {
    await precacheNotifiedObservations( [], { api_token: "token" } );

    expect( fetchRemoteObservations ).not.toHaveBeenCalled( );
  } );

  it( "caches the full observation behind each notification", async ( ) => {
    const observation = { uuid: "obs-uuid", comments: [{ id: 7 }] };
    fetchRemoteObservations.mockResolvedValue( [observation] );

    await precacheNotifiedObservations(
      [{ resource_uuid: "obs-uuid" }],
      { api_token: "token" },
    );

    expect( fetchRemoteObservations ).toHaveBeenCalledWith(
      ["obs-uuid"],
      expect.objectContaining( { fields: expect.anything( ) } ),
      expect.anything( ),
    );
    expect( getCachedObservation( "obs-uuid" ).value ).toEqual( observation );
  } );

  it( "asks for each observation once, however many notifications point at it", async ( ) => {
    fetchRemoteObservations.mockResolvedValue( [] );

    await precacheNotifiedObservations(
      [
        { resource_uuid: "obs-uuid" },
        { resource_uuid: "obs-uuid" },
      ],
      { api_token: "token" },
    );

    expect( fetchRemoteObservations ).toHaveBeenCalledWith(
      ["obs-uuid"],
      expect.anything( ),
      expect.anything( ),
    );
  } );

  it( "only pre-caches the most recent notifications", async ( ) => {
    fetchRemoteObservations.mockResolvedValue( [] );
    const notifications = Array.from(
      { length: MAX_PRECACHED_OBSERVATIONS + 5 },
      ( _, i ) => ( { resource_uuid: `obs-${i}` } ),
    );

    await precacheNotifiedObservations( notifications, { api_token: "token" } );

    const [uuids] = fetchRemoteObservations.mock.calls[0];
    expect( uuids ).toHaveLength( MAX_PRECACHED_OBSERVATIONS );
    expect( uuids ).not.toContain( `obs-${MAX_PRECACHED_OBSERVATIONS}` );
  } );

  it( "warms both sizes an observation's photo is shown at", async ( ) => {
    fetchRemoteObservations.mockResolvedValue( [observationWithPhoto( "obs-uuid" )] );

    await precacheNotifiedObservations(
      [{ resource_uuid: "obs-uuid" }],
      { api_token: "token" },
    );

    expect( prefetch ).toHaveBeenCalledWith( [SQUARE_URL, LARGE_URL] );
  } );

  it( "does not fetch the same notification's observation twice", async ( ) => {
    fetchRemoteObservations.mockResolvedValue( [{ uuid: "obs-uuid" }] );
    const notifications = [{ id: 1, resource_uuid: "obs-uuid" }];

    await precacheNotifiedObservations( notifications, { api_token: "token" } );
    await precacheNotifiedObservations( notifications, { api_token: "token" } );

    expect( fetchRemoteObservations ).toHaveBeenCalledTimes( 1 );
  } );

  it( "fetches again when a new notification arrives for a cached observation", async ( ) => {
    fetchRemoteObservations.mockResolvedValue( [{ uuid: "obs-uuid" }] );

    await precacheNotifiedObservations(
      [{ id: 2, resource_uuid: "obs-uuid" }],
      { api_token: "token" },
    );
    await precacheNotifiedObservations(
      [{ id: 3, resource_uuid: "obs-uuid" }, { id: 2, resource_uuid: "obs-uuid" }],
      { api_token: "token" },
    );

    expect( fetchRemoteObservations ).toHaveBeenCalledTimes( 2 );
  } );

  it( "caches nothing when the request fails", async ( ) => {
    fetchRemoteObservations.mockResolvedValue( null );

    await precacheNotifiedObservations(
      [{ resource_uuid: "obs-uuid" }],
      { api_token: "token" },
    );

    expect( getCachedObservation( "obs-uuid" ) ).toBeUndefined( );
    expect( prefetch ).not.toHaveBeenCalled( );
  } );
} );
