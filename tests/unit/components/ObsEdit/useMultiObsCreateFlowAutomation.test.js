import { useNavigationState } from "@react-navigation/native";
import { renderHook } from "@testing-library/react-native";
import useMultiObsCreateFlowAutomation
  from "components/ObsEdit/hooks/useMultiObsCreateFlowAutomation";
import useStore from "stores/useStore";
import factory from "tests/factory";

jest.unmock( "components/ObsEdit/hooks/useMultiObsCreateFlowAutomation" );

const mockPush = jest.fn( );
const mockNavigate = jest.fn( );
let mockRouteParams;

jest.mock( "@react-navigation/native", ( ) => ( {
  ...jest.requireActual( "@react-navigation/native" ),
  useIsFocused: ( ) => true,
  useNavigation: ( ) => ( {
    push: mockPush,
    navigate: mockNavigate,
  } ),
  useNavigationState: jest.fn( ( ) => false ),
  useRoute: ( ) => ( { params: mockRouteParams } ),
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
    mockRouteParams = undefined;
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

  describe( "without photos", ( ) => {
    const soundObs = factory( "LocalObservation", {
      latitude: 1.2,
      longitude: -122.4,
      observationPhotos: [],
      taxon: { id: 48460, rank_level: 100 },
      uuid: "obs-sound",
    } );

    it( "opens taxon search", ( ) => {
      renderHook( () => useMultiObsCreateFlowAutomation( {
        currentObservation: soundObs,
        isFetchingLocation: false,
      } ) );

      expect( mockNavigate ).toHaveBeenCalledWith( "SuggestionsTaxonSearch", expect.anything( ) );
    } );

    it( "stays on the observation when it came from a share", ( ) => {
      mockRouteParams = { lastScreen: "PhotoSharing" };

      renderHook( () => useMultiObsCreateFlowAutomation( {
        currentObservation: soundObs,
        isFetchingLocation: false,
      } ) );

      expect( mockNavigate ).not.toHaveBeenCalled( );
    } );
  } );
} );
