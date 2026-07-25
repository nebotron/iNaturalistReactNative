import {
  NavigationContainer,
  useNavigation, useNavigationState, useRoute,
} from "@react-navigation/native";
import {
  fireEvent, render, screen, waitFor,
} from "@testing-library/react-native";
import TaxonDetails from "components/TaxonDetails/TaxonDetails";
import INatPaperProvider from "providers/INatPaperProvider";
import React from "react";
import { useAuthenticatedQuery } from "sharedHooks";
import * as useCurrentUser from "sharedHooks/useCurrentUser";
import useStore from "stores/useStore";
import factory from "tests/factory";
import faker from "tests/helpers/faker";

jest.mock( "inaturalistjs" );

const mockTaxon = factory( "RemoteTaxon", {
  name: faker.person.firstName( ),
  rank: "species",
  rank_level: 10,
  preferred_common_name: faker.person.fullName( ),
  default_photo: { square_url: faker.image.url( ) },
  taxonPhotos: [{ photo: factory( "RemotePhoto" ) }],
} );

const mockUser = factory( "LocalUser", { login: faker.internet.userName( ) } );

jest.mock( "@react-navigation/native", ( ) => {
  const actualNav = jest.requireActual( "@react-navigation/native" );
  return {
    ...actualNav,
    useRoute: jest.fn( ),
    useNavigation: jest.fn( ),
    useNavigationState: jest.fn( ),
  };
} );

const mockSaveAndAdvance = jest.fn( async ( ) => true );
jest.mock( "components/ObsEdit/hooks/useMultiObsSaveAndAdvance", ( ) => ( {
  __esModule: true,
  default: ( ) => ( { saveAndAdvance: mockSaveAndAdvance } ),
} ) );

jest.mock( "sharedHooks/useAuthenticatedQuery", ( ) => ( {
  __esModule: true,
  default: jest.fn( ( ) => ( { data: null, isLoading: false, isError: false } ) ),
} ) );
jest.mock( "sharedHooks/useQuery", ( ) => ( {
  __esModule: true,
  default: jest.fn( ( ) => ( { data: null } ) ),
} ) );

const mockDispatch = jest.fn( );
const mockNavigate = jest.fn( );

const renderTaxonDetails = ( ) => render(
  <INatPaperProvider>
    <NavigationContainer>
      <TaxonDetails />
    </NavigationContainer>
  </INatPaperProvider>,
);

describe( "TaxonDetails SELECT in bulk ID flow", ( ) => {
  beforeAll( ( ) => {
    jest.spyOn( useCurrentUser, "default" ).mockImplementation( ( ) => mockUser );
    jest.useFakeTimers( );
  } );

  beforeEach( ( ) => {
    jest.clearAllMocks( );
    useAuthenticatedQuery.mockImplementation( ( ) => ( {
      data: mockTaxon, isLoading: false, isError: false,
    } ) );
    useRoute.mockImplementation( ( ) => ( { params: { id: mockTaxon.id } } ) );
    useNavigation.mockImplementation( ( ) => ( {
      dispatch: mockDispatch,
      navigate: mockNavigate,
      setOptions: jest.fn( ),
      addListener: jest.fn( ( ) => jest.fn( ) ),
      canGoBack: ( ) => true,
      goBack: jest.fn( ),
      push: jest.fn( ),
      setParams: jest.fn( ),
    } ) );

    useStore.getState( ).resetObservationFlowSlice( );
    useStore.setState( {
      observations: [
        factory( "LocalObservation", { uuid: "obs-0" } ),
        factory( "LocalObservation", { uuid: "obs-1" } ),
      ],
      currentObservation: factory( "LocalObservation", { uuid: "obs-0" } ),
      currentObservationIndex: 0,
      bulkUploadMode: true,
    } );
  } );

  async function pressSelectAndGetPopToTarget( ) {
    renderTaxonDetails( );
    const selectButton = await screen.findByText( /SELECT THIS TAXON/ );
    fireEvent.press( selectButton );
    await waitFor( ( ) => expect( mockSaveAndAdvance ).toHaveBeenCalled( ) );
    await waitFor( ( ) => expect( mockDispatch ).toHaveBeenCalled( ) );
    return mockDispatch.mock.calls[0][0]?.payload?.name;
  }

  it( "returns to Suggestions when entered from My Observations (bulk ID flow)", async ( ) => {
    // Stack has no ObsEdit screen (entered directly at Suggestions)
    useNavigationState.mockImplementation( ( ) => ( {
      routes: [
        { name: "ObsList" },
        { name: "Suggestions", params: { entryScreen: "ObsEdit", lastScreen: "ObsEdit" } },
        { name: "TaxonDetails", params: { id: mockTaxon.id } },
      ],
    } ) );
    expect( await pressSelectAndGetPopToTarget( ) ).toEqual( "Suggestions" );
  } );

  it( "still returns to ObsEdit in the regular multi-obs create flow", async ( ) => {
    // Stack includes an ObsEdit screen (obs created then edited)
    useNavigationState.mockImplementation( ( ) => ( {
      routes: [
        { name: "ObsEdit" },
        { name: "Suggestions", params: { entryScreen: "ObsEdit", lastScreen: "ObsEdit" } },
        { name: "TaxonDetails", params: { id: mockTaxon.id } },
      ],
    } ) );
    expect( await pressSelectAndGetPopToTarget( ) ).toEqual( "ObsEdit" );
  } );

  it( "returns to Suggestions when an unrelated ObsEdit visit lingers earlier in history", async ( ) => {
    // An ObsEdit screen from an unrelated, unfinished flow earlier in the
    // session (e.g. a notification tap) is still buried in the stack, but
    // this bulk ID flow was entered directly from My Observations, so it
    // should still advance to Suggestions rather than popping into the
    // stale ObsEdit screen.
    useNavigationState.mockImplementation( ( ) => ( {
      routes: [
        { name: "ObsEdit" },
        { name: "ObsDetails" },
        { name: "ObsList" },
        { name: "Suggestions", params: { entryScreen: "ObsEdit", lastScreen: "ObsEdit" } },
        { name: "TaxonDetails", params: { id: mockTaxon.id } },
      ],
    } ) );
    expect( await pressSelectAndGetPopToTarget( ) ).toEqual( "Suggestions" );
  } );
} );
