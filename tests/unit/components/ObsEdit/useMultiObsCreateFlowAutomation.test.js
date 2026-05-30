import { useNavigationState } from "@react-navigation/native";
import { renderHook, waitFor } from "@testing-library/react-native";
import useMultiObsCreateFlowAutomation from "components/ObsEdit/hooks/useMultiObsCreateFlowAutomation";
import useStore from "stores/useStore";
import factory from "tests/factory";

const mockPush = jest.fn( );
const mockNavigate = jest.fn( );

jest.mock( "@react-navigation/native", ( ) => ( {
  ...jest.requireActual( "@react-navigation/native" ),
  useIsFocused: ( ) => true,
  useNavigation: ( ) => ( {
    push: mockPush,
    navigate: mockNavigate,
  } ),
  useNavigationState: jest.fn( ( ) => false ),
} ) );

describe( "useMultiObsCreateFlowAutomation", ( ) => {
  const observation = factory( "LocalObservation", {
    latitude: 1.2,
    longitude: -122.4,
    observationPhotos: [{ photo: { url: "file:///photo.jpg" } }],
    taxon: undefined,
    uuid: "obs-1",
  } );

  beforeEach( ( ) => {
    jest.clearAllMocks( );
    useStore.getState( ).resetObservationFlowSlice( );
    useStore.setState( {
      observations: [observation, factory( "LocalObservation", { uuid: "obs-2" } )],
      currentObservation: observation,
    } );
    jest.mocked( useNavigationState ).mockReturnValue( false );
  } );

  it( "opens suggestions when location is available during multi-obs create", ( ) => {
    renderHook( () => useMultiObsCreateFlowAutomation( {
      currentObservation: observation,
      isFetchingLocation: false,
    } ) );

    expect( mockPush ).toHaveBeenCalledWith( "Suggestions", expect.objectContaining( {
      entryScreen: "ObsEdit",
      lastScreen: "ObsEdit",
    } ) );
  } );

  it( "does not open suggestions when already on the suggestions screen", ( ) => {
    jest.mocked( useNavigationState ).mockReturnValue( true );

    renderHook( () => useMultiObsCreateFlowAutomation( {
      currentObservation: observation,
      isFetchingLocation: false,
    } ) );

    expect( mockPush ).not.toHaveBeenCalled( );
  } );

  it( "does not open suggestions while location is still being fetched", ( ) => {
    renderHook( () => useMultiObsCreateFlowAutomation( {
      currentObservation: observation,
      isFetchingLocation: true,
    } ) );

    expect( mockPush ).not.toHaveBeenCalled( );
  } );
} );
