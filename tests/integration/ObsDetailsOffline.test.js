import { screen } from "@testing-library/react-native";
import ObsDetailsScreen from "components/ObsDetailsSharedComponents/ObsDetailsScreen";
import inatjs from "inaturalistjs";
import React from "react";
import {
  clearNotificationsCache,
  setCachedObservations,
} from "sharedHelpers/notificationsCache";
import factory from "tests/factory";
import { queryClient, renderAppWithComponent } from "tests/helpers/render";
import setupUniqueRealm from "tests/helpers/uniqueRealm";
import { signIn, signOut } from "tests/helpers/user";

// UNIQUE REALM SETUP
const mockRealmIdentifier = __filename;
const { mockRealmModelsIndex, uniqueRealmBeforeAll, uniqueRealmAfterAll } = setupUniqueRealm(
  mockRealmIdentifier,
);
jest.mock( "realmModels/index", ( ) => mockRealmModelsIndex );
jest.mock( "providers/contexts", ( ) => {
  const originalModule = jest.requireActual( "providers/contexts" );
  return {
    __esModule: true,
    ...originalModule,
    RealmContext: {
      ...originalModule.RealmContext,
      useRealm: ( ) => global.mockRealms[mockRealmIdentifier],
      useQuery: ( ) => [],
    },
  };
} );
beforeAll( uniqueRealmBeforeAll );
afterAll( uniqueRealmAfterAll );
// /UNIQUE REALM SETUP

const mockUser = factory( "LocalUser" );
const mockComment = factory( "RemoteComment" );
const mockObservation = factory( "RemoteObservation", {
  comments: [mockComment],
  user: mockUser,
} );

jest.mock( "inaturalistjs" );

// The scenario under test: the phone has no connection, so nothing this
// screen would normally fetch is available
jest.mock( "@react-native-community/netinfo", ( ) => ( {
  ...jest.requireActual( "@react-native-community/netinfo/jest/netinfo-mock" ),
  useNetInfo: ( ) => ( { isConnected: false } ),
} ) );

jest.mock( "@react-navigation/native", () => {
  const actualNav = jest.requireActual( "@react-navigation/native" );
  return {
    ...actualNav,
    addEventListener: () => undefined,
    useNavigation: () => ( {
      navigate: jest.fn(),
      push: jest.fn(),
      setOptions: jest.fn(),
      canGoBack: jest.fn( ( ) => true ),
    } ),
    useRoute: () => ( {
      params: {
        uuid: mockObservation.uuid,
      },
    } ),
  };
} );

describe( "an observation a user was notified about", ( ) => {
  beforeEach( async ( ) => {
    jest.useFakeTimers( );
    signIn( mockUser, { realm: global.mockRealms[__filename] } );
    inatjs.observations.fetch.mockRejectedValue( new Error( "Network request failed" ) );
  } );

  afterEach( ( ) => {
    jest.clearAllMocks( );
    signOut( { realm: global.mockRealms[__filename] } );
    queryClient.clear( );
    clearNotificationsCache( );
  } );

  it( "opens offline from the pre-cached copy, with no local observation", async ( ) => {
    expect(
      global.mockRealms[__filename].objectForPrimaryKey( "Observation", mockObservation.uuid ),
    ).toBeFalsy( );
    setCachedObservations( [mockObservation] );

    renderAppWithComponent( <ObsDetailsScreen /> );

    expect( await screen.findByText( mockObservation.user.login ) ).toBeVisible( );
  } );

  it( "shows nothing to open when it was never pre-cached", async ( ) => {
    renderAppWithComponent( <ObsDetailsScreen /> );

    expect( screen.queryByText( mockObservation.user.login ) ).toBeNull( );
  } );
} );
