import { fireEvent, render, screen } from "@testing-library/react-native";
import DateTimePicker from "components/SharedComponents/DateTimePicker";
import React from "react";
import { Pressable as MockPressable } from "react-native";

const STALE_DATE = new Date( "2024-03-05T12:00:00" );
const SETTLED_DATE = new Date( "2024-03-09T12:00:00" );

// Mimics the modal: Confirm reports what the wheel showed when tapped, and
// onHide later reports the value the wheel settled on. Like the real modal,
// it stays mounted while hiding so onHide can still fire.
// Jest's react-native preset runs as iOS.
jest.mock( "react-native-modal-datetime-picker", () => function (
  { onConfirm, onHide },
) {
  return (
    <>
      <MockPressable
        accessibilityRole="button"
        testID="confirm"
        onPress={( ) => onConfirm( STALE_DATE )}
      />
      <MockPressable
        accessibilityRole="button"
        testID="hide"
        onPress={( ) => onHide?.( true, SETTLED_DATE )}
      />
      <MockPressable
        accessibilityRole="button"
        testID="cancel-hide"
        onPress={( ) => onHide?.( false, SETTLED_DATE )}
      />
    </>
  );
} );

const renderPicker = onDatePicked => render(
  <DateTimePicker
    isDateTimePickerVisible
    onDatePicked={onDatePicked}
    toggleDateTimePicker={jest.fn( )}
  />,
);

describe( "DateTimePicker", ( ) => {
  it( "on iOS commits the value the wheel settled on, not the one at Confirm", ( ) => {
    const onDatePicked = jest.fn( );
    renderPicker( onDatePicked );

    fireEvent.press( screen.getByTestId( "confirm" ) );
    expect( onDatePicked ).not.toHaveBeenCalled( );
    fireEvent.press( screen.getByTestId( "hide" ) );
    expect( onDatePicked ).toHaveBeenCalledTimes( 1 );
    expect( onDatePicked ).toHaveBeenCalledWith( SETTLED_DATE );
  } );

  it( "on iOS commits nothing when the picker hides without Confirm", ( ) => {
    const onDatePicked = jest.fn( );
    renderPicker( onDatePicked );

    fireEvent.press( screen.getByTestId( "cancel-hide" ) );
    expect( onDatePicked ).not.toHaveBeenCalled( );
  } );
} );
