import { renderHook, waitFor } from "@testing-library/react-native";
import useNavigateWithTaxonSelected from "components/Suggestions/hooks/useNavigateWithTaxonSelected";
import useStore from "stores/useStore";
import factory from "tests/factory";

const mockNavigate = jest.fn( );
const mockDispatch = jest.fn( );
const mockSaveAndAdvance = jest.fn( async ( ) => true );

jest.mock( "@react-navigation/native", ( ) => ( {
  ...jest.requireActual( "@react-navigation/native" ),
  useNavigation: ( ) => ( {
    navigate: mockNavigate,
    dispatch: mockDispatch,
  } ),
  useRoute: ( ) => ( {
    params: {
      entryScreen: "ObsEdit",
      lastScreen: "ObsEdit",
    },
  } ),
} ) );

jest.mock( "components/ObsEdit/hooks/useMultiObsSaveAndAdvance", ( ) => ( {
  __esModule: true,
  default: ( ) => ( {
    saveAndAdvance: mockSaveAndAdvance,
  } ),
} ) );

describe( "useNavigateWithTaxonSelected", ( ) => {
  const observation = factory( "LocalObservation", {
    uuid: "obs-1",
    observationPhotos: [{ photo: { url: "file:///photo.jpg" } }],
  } );

  beforeEach( ( ) => {
    jest.clearAllMocks( );
    useStore.getState( ).resetObservationFlowSlice( );
    useStore.setState( {
      observations: [observation, factory( "LocalObservation", { uuid: "obs-2" } )],
      currentObservation: observation,
      currentObservationIndex: 0,
    } );
  } );

  it( "saves and stays on suggestions during multi-obs create flow", async ( ) => {
    const taxon = factory( "RemoteTaxon", { id: 123, rank_level: 10 } );
    const { result } = renderHook( () => useNavigateWithTaxonSelected( { vision: true } ) );

    await result.current( taxon );

    await waitFor( ( ) => {
      expect( mockSaveAndAdvance ).toHaveBeenCalledWith( "save" );
    } );
    expect( mockNavigate ).not.toHaveBeenCalledWith( "ObsEdit" );
  } );
} );
