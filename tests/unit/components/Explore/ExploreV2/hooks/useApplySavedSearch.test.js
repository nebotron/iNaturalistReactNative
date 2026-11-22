import { act } from "@testing-library/react-native";
import useApplySavedSearch from "components/Explore/ExploreV2/hooks/useApplySavedSearch";
import { EXPLORE_V2_ACTION } from "providers/ExploreV2Context";
import { renderHookInApp } from "tests/helpers/render";
import { savedSearch as buildSavedSearch } from "tests/helpers/savedSearch";

const mockPopTo = jest.fn( );
const mockTabDispatch = jest.fn( );
const mockTabGoBack = jest.fn( );
const mockTabStack = {
  dispatch: mockTabDispatch,
  goBack: mockTabGoBack,
  getState: ( ) => ( {
    index: 1,
    routes: [
      { key: "root-explore", name: "RootExplore" },
      { key: "hotspot-explore", name: "Explore" },
    ],
  } ),
};
jest.mock( "@react-navigation/native", ( ) => ( {
  ...jest.requireActual( "@react-navigation/native" ),
  useNavigation: ( ) => ( { popTo: mockPopTo, getParent: ( ) => mockTabStack } ),
} ) );

const mockDispatch = jest.fn( );
let mockFromHotspot = false;
jest.mock( "providers/ExploreV2Context", ( ) => ( {
  ...jest.requireActual( "providers/ExploreV2Context" ),
  useExploreV2: ( ) => ( { dispatch: mockDispatch, state: {} } ),
  useExploreFromHotspot: ( ) => mockFromHotspot,
} ) );

const applySearch = search => {
  const { result } = renderHookInApp( ( ) => useApplySavedSearch( ) );
  act( ( ) => result.current( search ) );
};

beforeEach( ( ) => {
  mockDispatch.mockClear( );
  mockPopTo.mockClear( );
  mockTabDispatch.mockClear( );
  mockTabGoBack.mockClear( );
  mockFromHotspot = false;
} );

describe( "useApplySavedSearch", ( ) => {
  it( "applies the search and returns to the results", ( ) => {
    const search = buildSavedSearch( );

    applySearch( search );

    expect( mockDispatch ).toHaveBeenCalledWith( {
      type: EXPLORE_V2_ACTION.APPLY_SEARCH,
      search,
    } );
    expect( mockPopTo ).toHaveBeenCalledWith( "ExploreResults" );
  } );

  it( "replaces an Explore opened from a hotspot with the Explore it came from", ( ) => {
    mockFromHotspot = true;
    const search = buildSavedSearch( );

    applySearch( search );

    expect( mockDispatch ).not.toHaveBeenCalled( );
    expect( mockPopTo ).not.toHaveBeenCalled( );
    expect( mockTabDispatch ).toHaveBeenCalledWith( expect.objectContaining( {
      source: "root-explore",
      payload: {
        params: { loadSavedSearch: search },
      },
    } ) );
    expect( mockTabGoBack ).toHaveBeenCalled( );
  } );
} );
