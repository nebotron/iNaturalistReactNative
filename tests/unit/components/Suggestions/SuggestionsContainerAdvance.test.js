import { act } from "@testing-library/react-native";
import SuggestionsScreen from "components/Suggestions/SuggestionsContainer";
import React from "react";
import ObservationPhoto from "realmModels/ObservationPhoto";
import useStore from "stores/useStore";
import factory from "tests/factory";
import { renderComponent } from "tests/helpers/render";

const mockRenders = [];
jest.mock( "components/Suggestions/Suggestions", ( ) => ( {
  __esModule: true,
  default: props => {
    mockRenders.push( {
      photoUris: props.photoUris,
      selectedPhotoUri: props.selectedPhotoUri,
    } );
    return null;
  },
} ) );

// Building image params resizes the photo, which takes a while on a device.
// Hold every request open so the test controls when they finish.
const mockPendingParams = [];
jest.mock( "components/Suggestions/helpers/flattenUploadParams", ( ) => ( {
  __esModule: true,
  default: uri => new Promise( resolve => {
    mockPendingParams.push( ( ) => resolve( { image: { uri, name: "p", type: "image/jpeg" } } ) );
  } ),
} ) );

jest.mock( "@react-navigation/native", ( ) => ( {
  ...jest.requireActual( "@react-navigation/native" ),
  useNavigation: ( ) => ( {
    addListener: ( ) => ( ) => undefined,
    setOptions: jest.fn( ),
    navigate: jest.fn( ),
    dispatch: jest.fn( ),
  } ),
  useRoute: ( ) => ( { name: "Suggestions", params: {} } ),
  useNavigationState: selector => selector( { routes: [{ name: "Suggestions" }] } ),
} ) );

const makeObservation = uuid => factory( "LocalObservation", {
  uuid,
  observationPhotos: [{ photo: { url: `file:///${uuid}.jpg` } }],
} );

describe( "SuggestionsContainer advancing to the next observation", ( ) => {
  it( "switches the selected photo in the same render as the photos", async ( ) => {
    const first = makeObservation( "obs-1" );
    const second = makeObservation( "obs-2" );
    const third = makeObservation( "obs-3" );
    useStore.setState( {
      observations: [first, second, third],
      currentObservation: first,
      currentObservationIndex: 0,
    } );
    renderComponent( <SuggestionsScreen /> );

    // Advance twice before any image params are ready
    act( ( ) => {
      useStore.setState( { currentObservation: second, currentObservationIndex: 1 } );
    } );
    act( ( ) => {
      useStore.setState( { currentObservation: third, currentObservationIndex: 2 } );
    } );
    // Then let the earlier requests finish last
    await act( async ( ) => {
      mockPendingParams.forEach( resolve => resolve( ) );
    } );

    mockRenders.forEach( ( { photoUris, selectedPhotoUri } ) => {
      expect( photoUris ).toContain( selectedPhotoUri );
    } );
    const lastRender = mockRenders[mockRenders.length - 1];
    expect( lastRender.selectedPhotoUri )
      .toEqual( ObservationPhoto.mapObsPhotoUris( third )[0] );
  } );
} );
