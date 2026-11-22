import { waitFor } from "@testing-library/react-native";
import inatjs from "inaturalistjs";
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

  beforeEach( ( ) => {
    queryClient.clear( );
    inatjs.observations.updates.mockImplementation( params => {
      if ( params.per_page === 0 ) {
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
} );
