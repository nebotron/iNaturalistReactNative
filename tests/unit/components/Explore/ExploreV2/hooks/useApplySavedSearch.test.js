import { act } from "@testing-library/react-native";
import useApplySavedSearch from "components/Explore/ExploreV2/hooks/useApplySavedSearch";
import { EXPLORE_V2_ACTION } from "providers/ExploreV2Context";
import { renderHookInApp } from "tests/helpers/render";
import { savedSearch as buildSavedSearch } from "tests/helpers/savedSearch";

const mockPopTo = jest.fn( );
jest.mock( "@react-navigation/native", ( ) => ( {
  ...jest.requireActual( "@react-navigation/native" ),
  useNavigation: ( ) => ( { popTo: mockPopTo } ),
} ) );

const mockDispatch = jest.fn( );
jest.mock( "providers/ExploreV2Context", ( ) => ( {
  ...jest.requireActual( "providers/ExploreV2Context" ),
  useExploreV2: ( ) => ( { dispatch: mockDispatch, state: {} } ),
} ) );

const applySearch = search => {
  const { result } = renderHookInApp( ( ) => useApplySavedSearch( ) );
  act( ( ) => result.current( search ) );
};

beforeEach( ( ) => {
  mockDispatch.mockClear( );
  mockPopTo.mockClear( );
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
} );
