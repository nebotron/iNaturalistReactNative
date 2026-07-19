import * as React from "react";
import DateTimePicker from "react-native-modal-datetime-picker";

interface Props {
  date?: Date;
  toggleDateTimePicker: () => void;
  onDatePicked: ( date: Date ) => void;
  isDateTimePickerVisible: boolean;
  datetime?: boolean;
}

// using component from Seek: https://github.com/inaturalist/SeekReactNative/blob/64ae3df185fffe751aff40ab17e3ff2dd8a74e42/components/UIComponents/DateTimePicker.js

const EmptyHeader = ( ) => null;

const DatePicker = ( {
  date,
  datetime = false,
  isDateTimePickerVisible,
  onDatePicked,
  toggleDateTimePicker,
}: Props ) => {
  const [pickedDate, setPickedDate] = React.useState<Date | undefined>( undefined );
  const [isTimeVisible, setIsTimeVisible] = React.useState( false );
  // Internal visibility so we can fully dismiss the modal between the date and
  // time steps. Swapping the picker's `mode` while the modal is still visible
  // can leave an orphaned backdrop mounted over the screen that intercepts all
  // touches, making the whole UI unresponsive. Instead we hide the date step,
  // wait for its `onHide`, then present the time step on a clean backdrop.
  const [isVisible, setIsVisible] = React.useState( false );
  const advanceToTime = React.useRef( false );

  // Keep internal visibility in sync with the parent-controlled flag and reset
  // the two-step state whenever the picker (re)opens or closes.
  React.useEffect( ( ) => {
    if ( isDateTimePickerVisible ) {
      setIsTimeVisible( false );
      setPickedDate( undefined );
      advanceToTime.current = false;
      setIsVisible( true );
    } else {
      advanceToTime.current = false;
      setIsVisible( false );
    }
  }, [isDateTimePickerVisible] );

  const handleHide = ( ) => {
    // Once the date step has finished hiding, present the time step.
    if ( advanceToTime.current ) {
      advanceToTime.current = false;
      setIsTimeVisible( true );
      setIsVisible( true );
    }
  };

  if ( datetime && isTimeVisible ) {
    return (
      <DateTimePicker
        display="spinner"
        customHeaderIOS={EmptyHeader}
        isDarkModeEnabled={false}
        themeVariant="light"
        isVisible={isVisible}
        maximumDate={new Date( )}
        mode="time"
        onCancel={toggleDateTimePicker}
        onConfirm={selectedDate => {
          onDatePicked( selectedDate );
          toggleDateTimePicker( );
        }}
        onHide={handleHide}
        date={pickedDate || date || new Date( )}
      />
    );
  }

  // Base case we want to pick a date
  return (
    <DateTimePicker
      display="spinner"
      customHeaderIOS={EmptyHeader}
      isDarkModeEnabled={false}
      themeVariant="light"
      isVisible={isVisible}
      maximumDate={new Date( )}
      mode="date"
      onCancel={toggleDateTimePicker}
      onConfirm={selectedDate => {
        if ( datetime ) {
          // Remember the picked date, hide the date step, and let `onHide`
          // open the time step on a fresh backdrop.
          setPickedDate( selectedDate );
          advanceToTime.current = true;
          setIsVisible( false );
        } else {
          onDatePicked( selectedDate );
          toggleDateTimePicker( );
        }
      }}
      onHide={handleHide}
      date={date || new Date( )}
    />
  );
};

export default DatePicker;
