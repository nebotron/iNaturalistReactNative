import {
  screen,
  userEvent,
} from "@testing-library/react-native";
import useStore from "stores/useStore";
// import os from "os";
// import path from "path";
// import Realm from "realm";
// import realmConfig from "realmModels/index";
import factory from "tests/factory";
import {
  mockInteractionManagerRunAfterInteractions,
} from "tests/helpers/addObsBottomSheet";
import faker from "tests/helpers/faker";
import {
  renderAppWithObservations,
} from "tests/helpers/render";
import setStoreStateLayout from "tests/helpers/setStoreStateLayout";
import setupUniqueRealm from "tests/helpers/uniqueRealm";
import { signIn, signOut } from "tests/helpers/user";

// We're explicitly testing navigation here so we want react-navigation
// working normally
jest.unmock( "@react-navigation/native" );

// UNIQUE REALM SETUP
const mockRealmIdentifier = __filename;
const { mockRealmModelsIndex, uniqueRealmBeforeAll, uniqueRealmAfterAll } = setupUniqueRealm(
  mockRealmIdentifier,
);
jest.mock( "realmModels/index", ( ) => mockRealmModelsIndex );
jest.mock( "providers/contexts", ( ) => {
  const originalModule = jest.requireActual( "providers/contexts" );
  const { makeRealmHooks } = jest.requireActual( "tests/helpers/uniqueRealm" );
  return {
    __esModule: true,
    ...originalModule,
    RealmContext: {
      ...originalModule.RealmContext,
      ...makeRealmHooks( __filename ),
    },
  };
} );
beforeAll( uniqueRealmBeforeAll );
afterAll( uniqueRealmAfterAll );
// /UNIQUE REALM SETUP

const actor = userEvent.setup( );

beforeEach( ( ) => {
  setStoreStateLayout( {
    isDefaultMode: false,
    isAllAddObsOptionsMode: true,
  } );
} );

describe( "ObsEdit", ( ) => {
  global.withAnimatedTimeTravelEnabled( { skipFakeTimers: true } );

  async function findAndPressById( labelText ) {
    const pressable = await screen.findByTestId( labelText );
    await actor.press( pressable );
    return pressable;
  }

  const mockUser = factory( "LocalUser", {
    login: faker.internet.userName( ),
    iconUrl: faker.image.url( ),
    locale: "en",
  } );

  const observation = factory( "LocalObservation", {
    _created_at: faker.date.past( ),
    taxon: factory( "LocalTaxon", {
      name: faker.person.firstName( ),
    } ),
  } );

  const mockObservations = [observation];

  beforeAll( async () => {
    jest.useFakeTimers( );
    mockInteractionManagerRunAfterInteractions( );
    useStore.setState( {
      initialNumObservationsInQueue: 3,
      numUploadsAttempted: 2,
    } );
  } );

  describe( "from MyObservations", ( ) => {
    async function navigateToObsEditOrObsDetails( observations ) {
      await renderAppWithObservations( observations, __filename );
      const observationGridItem = await screen.findByTestId(
        `MyObservations.obsGridItem.${observations[0].uuid}`,
      );
      await actor.press( observationGridItem );
    }

    it( "should show correct observation when navigating from MyObservations", async ( ) => {
      await navigateToObsEditOrObsDetails( mockObservations );
      expect( await screen.findByText( /Edit Observation/ ) ).toBeTruthy( );
      expect( await screen.findByText( mockObservations[0].taxon.name ) ).toBeTruthy( );
    } );

    describe( "while signed in", ( ) => {
      beforeEach( async ( ) => {
        await signIn( mockUser, { realm: global.mockRealms[__filename] } );
      } );

      afterEach( ( ) => {
        signOut( { realm: global.mockRealms[__filename] } );
      } );

      it( "should show correct observation when navigating from ObsDetails", async ( ) => {
        const syncedObservation = factory( "LocalObservation", {
          _created_at: faker.date.past( ),
          _synced_at: faker.date.past( ),
          wasSynced: jest.fn( ( ) => true ),
          needsSync: jest.fn( ( ) => false ),
          taxon: factory( "LocalTaxon", {
            name: faker.person.firstName( ),
          } ),
        } );
        await navigateToObsEditOrObsDetails( [syncedObservation] );
        await findAndPressById( "ObsDetail.editButton" );
        expect( await screen.findByText( /Edit Observation/ ) ).toBeTruthy( );
        expect( await screen.findByText( syncedObservation.taxon.name ) ).toBeTruthy( );
      } );

      it.todo( "should show photos when reached from ObsDetails" );
    } );
  } );
} );
