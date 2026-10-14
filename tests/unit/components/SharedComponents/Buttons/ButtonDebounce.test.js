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

  // The log shows the JS thread healthy through every reported "unresponsive"
  // episode, so a latched control is what is left to look for and nothing in
  // the app could see one.
  it( "reports a button left loading far too long", ( ) => {
    // The logger mock in jest.setup funnels errorWithExtra into console.error.
    const reported = jest.spyOn( console, "error" ).mockImplementation( ( ) => undefined );
    const { rerender } = render( <Button text="DELETE" onPress={jest.fn( )} loading /> );

    act( ( ) => { jest.advanceTimersByTime( 119_000 ); } );
    expect( reported ).not.toHaveBeenCalled( );

    act( ( ) => { jest.advanceTimersByTime( 2_000 ); } );
    expect( reported ).toHaveBeenCalledWith(
      "button_stuck_loading",
      expect.objectContaining( { text: "DELETE" } ),
    );

    // Work that finishes normally says nothing.
    reported.mockClear( );
    rerender( <Button text="DELETE" onPress={jest.fn( )} loading={false} /> );
    act( ( ) => { jest.advanceTimersByTime( 300_000 ); } );
    expect( reported ).not.toHaveBeenCalled( );
    reported.mockRestore( );
  } );
} );
