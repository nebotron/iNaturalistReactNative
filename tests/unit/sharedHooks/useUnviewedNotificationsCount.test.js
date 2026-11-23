import { act, waitFor } from "@testing-library/react-native";
import inatjs from "inaturalistjs";
import {
  clearPersistedQueries,
  persistQueries,
  readPersistedQuery,
} from "sharedHelpers/persistedQueries";
import { getNotificationsFullQueryKey } from "sharedHooks/useInfiniteNotificationsScroll";
import useUnviewedNotificationsCount from "sharedHooks/useUnviewedNotificationsCount";
import factory, { makeResponse } from "tests/factory";
import { queryClient, renderHookInApp } from "tests/helpers/render";

const mockUser = { id: 123, login: "notified" };

jest.mock( "sharedHooks/useCurrentUser", ( ) => ( {
  __esModule: true,
  default: ( ) => mockUser,
} ) );

jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  getJWT: jest.fn( ( ) => Promise.resolve( "test-jwt" ) ),
  isLoggedIn: jest.fn( ( ) => Promise.resolve( true ) ),
} ) );

const mockObservation = factory( "RemoteObservation", { user: mockUser } );
const mockComment = factory( "RemoteComment", { parent_id: mockObservation.id } );
const mockUpdate = {
  id: 1,
  comment: mockComment,
  comment_id: mockComment.id,
  notifier_type: "Comment",
  resource_uuid: mockObservation.uuid,
  viewed: false,
};

describe( "useUnviewedNotificationsCount with preload", ( ) => {
  let resolveList;
  let stopPersisting;

  beforeEach( ( ) => {
    queryClient.clear( );
    clearPersistedQueries( );
    resolveList = undefined;
    stopPersisting = persistQueries( queryClient, { writeDelayMs: 0 } );
    inatjs.observations.updates.mockImplementation( params => {
      if ( params.viewed === false ) {
        return Promise.resolve( {
          ...makeResponse( ),
          total_results: params.observations_by === "owner"
            ? 1
            : 0,
        } );
      }
      if ( params.observations_by === "following" ) {
        return Promise.resolve( makeResponse( [] ) );
      }
      return new Promise( resolve => {
        resolveList = ( ) => resolve( makeResponse( [mockUpdate] ) );
      } );
    } );
    inatjs.observations.fetch.mockResolvedValue( makeResponse( [mockObservation] ) );
  } );

  afterEach( ( ) => {
    // The preloaded list is kept for a day, and its timer would keep Jest running
    queryClient.clear( );
    stopPersisting( );
    inatjs.observations.updates.mockReset( );
    inatjs.observations.fetch.mockReset( );
  } );

  it( "reports a tab ready only once its notifications are loaded", async ( ) => {
    const { result } = renderHookInApp(
      ( ) => useUnviewedNotificationsCount( { preload: true } ),
    );
    await waitFor( ( ) => {
      expect( result.current.ownerUnviewedCount ).toEqual( 1 );
    } );
    await waitFor( ( ) => {
      expect( resolveList ).toBeDefined( );
    } );
    expect( result.current.ownerReady ).toBe( false );

    resolveList( );
    await waitFor( ( ) => {
      expect( result.current.ownerReady ).toBe( true );
    } );
    const cachedLists = queryClient.getQueriesData(
      { queryKey: ["useInfiniteNotificationsScroll"] },
    );
    const ownerList = cachedLists.find( ( [key] ) => key[1].includes( "owner" ) );
    expect( ownerList[1].pages[0][0].resource.uuid ).toEqual( mockObservation.uuid );
  } );

  it( "shows the tab ready straight away after a restart when nothing is new", async ( ) => {
    const view = renderHookInApp(
      ( ) => useUnviewedNotificationsCount( { preload: true } ),
    );
    await waitFor( ( ) => {
      expect( resolveList ).toBeDefined( );
    } );
    resolveList( );
    await waitFor( ( ) => {
      expect( view.result.current.ownerReady ).toBe( true );
    } );
    // Lets the write to disk, on a timer, happen
    await act( async ( ) => {
      await new Promise( resolve => { setTimeout( resolve, 10 ); } );
    } );
    view.unmount( );

    // Nothing in memory, only what was saved to disk
    queryClient.clear( );
    resolveList = undefined;
    const listRequests = ( ) => inatjs.observations.updates.mock.calls
      .filter( ( [params] ) => params.per_page !== 0 && params.observations_by === "owner" );
    const requestsBefore = listRequests( ).length;

    const { result } = renderHookInApp(
      ( ) => useUnviewedNotificationsCount( { preload: true } ),
    );
    await waitFor( ( ) => {
      expect( result.current.ownerReady ).toBe( true );
    } );
    expect( listRequests( ) ).toHaveLength( requestsBefore );
    const saved = readPersistedQuery(
      getNotificationsFullQueryKey( { observations_by: "owner" }, mockUser ),
    );
    expect( saved.pages[0][0].resource.uuid ).toEqual( mockObservation.uuid );
  } );
} );
