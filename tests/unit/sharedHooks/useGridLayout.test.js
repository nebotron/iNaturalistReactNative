import { renderHook } from "@testing-library/react-native";
import useGridLayout from "sharedHooks/useGridLayout";

jest.mock( "sharedHooks/useDeviceOrientation", ( ) => ( {
  __esModule: true,
  default: jest.fn( ( ) => ( {
    isLandscapeMode: false,
    isTablet: false,
    screenWidth: 400,
    screenHeight: 800,
  } ) ),
} ) );

describe( "useGridLayout", ( ) => {
  it( "uses a single full-width column with no gutters in fullWidth mode", ( ) => {
    const { result } = renderHook( ( ) => useGridLayout( undefined, "fullWidth" ) );

    expect( result.current.numColumns ).toBe( 1 );
    expect( result.current.gridItemStyle ).toEqual( {
      height: 400,
      width: 400,
      margin: 0,
    } );
    expect( result.current.flashListStyle ).toEqual( {
      paddingTop: 0,
      paddingLeft: 0,
      paddingRight: 0,
      paddingBottom: 80,
    } );
    expect( result.current.squareCorners ).toBe( true );
  } );
} );
