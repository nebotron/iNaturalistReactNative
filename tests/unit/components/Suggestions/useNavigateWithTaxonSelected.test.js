import { renderHook, waitFor } from "@testing-library/react-native";
import useNavigateWithTaxonSelected
  from "components/Suggestions/hooks/useNavigateWithTaxonSelected";
import useStore from "stores/useStore";
import factory from "tests/factory";

const mockNavigate = jest.fn( );
const mockDispatch = jest.fn( );
const mockSaveAndAdvance = jest.fn( async ( ) => true );

let mockRouteParams = {
  entryScreen: "ObsEdit",
  lastScreen: "ObsEdit",
};

jest.mock( "@react-navigation/native", ( ) => ( {
  ...jest.requireActual( "@react-navigation/native" ),
  useNavigation: ( ) => ( {
    navigate: mockNavigate,
    dispatch: mockDispatch,
  } ),
  useRoute: ( ) => ( {
    params: mockRouteParams,
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
    mockRouteParams = {
      entryScreen: "ObsEdit",
      lastScreen: "ObsEdit",
    };
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

  it( "saves instead of opening ObsEdit when the bulk ID flow has one observation", async ( ) => {
    useStore.setState( {
      observations: [observation],
      currentObservation: observation,
      currentObservationIndex: 0,
      bulkUploadMode: true,
    } );
    const taxon = factory( "RemoteTaxon", { id: 123, rank_level: 10 } );
    const { result } = renderHook( () => useNavigateWithTaxonSelected( { vision: true } ) );

    await result.current( taxon );

    await waitFor( ( ) => {
      expect( mockSaveAndAdvance ).toHaveBeenCalledWith( "upload" );
    } );
    expect( mockNavigate ).not.toHaveBeenCalled( );
    expect( mockDispatch ).not.toHaveBeenCalled( );
  } );

  it( "stays in the bulk ID flow when Suggestions has lost its params", async ( ) => {
    // Popping back to Suggestions from TaxonDetails replaces that screen's
    // params, so by the next observation there is no entryScreen or
    // lastScreen left to identify the flow by. Choosing a taxon should still
    // save and advance rather than open ObsEdit, which this stack has no
    // screen for.
    mockRouteParams = undefined;
    useStore.setState( { bulkUploadMode: true } );
    const taxon = factory( "RemoteTaxon", { id: 123, rank_level: 10 } );
    const { result } = renderHook( () => useNavigateWithTaxonSelected( { vision: true } ) );

    await result.current( taxon );

    await waitFor( ( ) => {
      expect( mockSaveAndAdvance ).toHaveBeenCalledWith( "upload" );
    } );
    expect( mockNavigate ).not.toHaveBeenCalledWith( "ObsEdit" );
  } );

  it( "returns to ObsDetails when suggesting an ID there after a bulk flow", async ( ) => {
    mockRouteParams = { entryScreen: "ObsDetails", lastScreen: "ObsDetails" };
    useStore.setState( { bulkUploadMode: true } );
    const taxon = factory( "RemoteTaxon", { id: 123, rank_level: 10 } );
    const { result } = renderHook( () => useNavigateWithTaxonSelected( { vision: false } ) );

    await result.current( taxon );

    expect( mockSaveAndAdvance ).not.toHaveBeenCalled( );
    expect( mockDispatch ).toHaveBeenCalled( );
    expect( mockDispatch.mock.calls[0][0]?.payload?.name ).toEqual( "ObsDetails" );
  } );
} );
