import {
  act, fireEvent, render, screen,
} from "@testing-library/react-native";
import { Button } from "components/SharedComponents";
import React from "react";

const runDebounce = ( ) => act( ( ) => { jest.runAllTimers( ); } );

describe( "Button debounce", ( ) => {
  beforeEach( ( ) => jest.useFakeTimers( ) );
  afterEach( ( ) => jest.useRealTimers( ) );

  it( "re-enables after the debounce window", ( ) => {
    const onPress = jest.fn( );
    render( <Button text="TAP" onPress={onPress} testID="btn" /> );

    fireEvent.press( screen.getByTestId( "btn" ) );
    expect( onPress ).toHaveBeenCalledTimes( 1 );
    expect( screen.getByTestId( "btn" ) ).toBeDisabled( );

    runDebounce( );
    expect( screen.getByTestId( "btn" ) ).toBeEnabled( );
  } );

  it( "re-enables after a handler that throws", ( ) => {
    const onPress = jest.fn( ( ) => { throw new Error( "boom" ); } );
    render( <Button text="TAP" onPress={onPress} testID="btn" /> );

    expect( ( ) => fireEvent.press( screen.getByTestId( "btn" ) ) ).toThrow( "boom" );
    runDebounce( );

    // A throwing handler used to leave the button disabled for the life of the
    // screen, i.e. until the app was restarted.
    expect( screen.getByTestId( "btn" ) ).toBeEnabled( );
    expect( ( ) => fireEvent.press( screen.getByTestId( "btn" ) ) ).toThrow( "boom" );
    expect( onPress ).toHaveBeenCalledTimes( 2 );
  } );
} );
