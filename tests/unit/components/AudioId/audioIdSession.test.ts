import { AppState } from "react-native";

// The session listens for app state changes when it loads, so grab that handler.
const addEventListener = jest.spyOn( AppState, "addEventListener" );
// eslint-disable-next-line import/first
import {
  startDimming, stopDimming, useScreenDimmed, useScreenPaused,
} from "components/AudioId/audioIdSession";

const changeAppState = ( state: string ) => {
  addEventListener.mock.calls.forEach( ( [type, handler] ) => {
    if ( type === "change" ) ( handler as ( s: string ) => void )( state );
  } );
};

describe( "Audio ID screen pausing", ( ) => {
  afterEach( ( ) => {
    stopDimming( );
    changeAppState( "active" );
  } );

  it( "pauses re-renders until the screen is focused", ( ) => {
    expect( useScreenPaused.getState( ) ).toBe( true );
    startDimming( );
    expect( useScreenPaused.getState( ) ).toBe( false );
  } );

  it( "pauses re-renders once the user leaves the screen", ( ) => {
    startDimming( );
    stopDimming( );
    expect( useScreenPaused.getState( ) ).toBe( true );
    expect( useScreenDimmed.getState( ) ).toBe( false );
  } );

  it( "pauses re-renders while the app is in the background", ( ) => {
    startDimming( );
    changeAppState( "background" );
    expect( useScreenPaused.getState( ) ).toBe( true );
    changeAppState( "active" );
    expect( useScreenPaused.getState( ) ).toBe( false );
  } );
} );
