import { act, renderHook } from "@testing-library/react-native";
import useLayoutPrefs from "sharedHooks/useLayoutPrefs";
import useStore from "stores/useStore";

describe( "useLayoutPrefs", ( ) => {
  it( "does not re-render when unrelated store state changes", ( ) => {
    let timesRendered = 0;
    renderHook( ( ) => {
      timesRendered += 1;
      return useLayoutPrefs( );
    } );

    // Something the layout slice knows nothing about, of the kind that changes
    // constantly while photos are being imported or uploaded
    act( ( ) => useStore.getState( ).setSavingPhoto( true ) );

    // Only the initial render: the unrelated change didn't reach this hook
    expect( timesRendered ).toBe( 1 );
  } );

  it( "re-renders when a layout pref changes", ( ) => {
    const { result } = renderHook( ( ) => useLayoutPrefs( ) );

    expect( result.current.loginBannerDismissed ).toBe( false );
    act( ( ) => result.current.setLoginBannerDismissed( ) );

    expect( result.current.loginBannerDismissed ).toBe( true );
  } );
} );
