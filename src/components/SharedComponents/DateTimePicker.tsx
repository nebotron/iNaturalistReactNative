import * as React from "react";
import DateTimePicker from "react-native-modal-datetime-picker";

type PickerMode = "date" | "time" | "datetime";

interface Props {
  date?: Date;
  toggleDateTimePicker: () => void;
  onDatePicked: ( date: Date ) => void;
  isDateTimePickerVisible: boolean;
  mode?: PickerMode;
}

// using component from Seek: https://github.com/inaturalist/SeekReactNative/blob/64ae3df185fffe751aff40ab17e3ff2dd8a74e42/components/UIComponents/DateTimePicker.js

const EmptyHeader = ( ) => null;

// react-native-modal-datetime-picker presents a native modal on top of whatever
// modal opened it, and takes 300ms to animate out before it actually goes away.
// Asking iOS to present it again while the previous presentation is still being
// dismissed silently drops the new presentation and leaves an invisible
// full-screen view behind that swallows every touch, which looks like the app
// freezing. So after a dismissal we refuse to present again until the old
// presentation has had time to finish leaving.
const DISMISS_MS = 400;

const DatePicker = ( {
  date,
  isDateTimePickerVisible,
  mode = "date",
  onDatePicked,
  toggleDateTimePicker,
}: Props ) => {
  const [selectedDateNoTime, setSelectedDateNoTime] = React.useState<Date | undefined>( undefined );
  const [isTimeVisible, setisTimeVisible] = React.useState( false );
  const [isDismissing, setIsDismissing] = React.useState( false );
  const dismissTimer = React.useRef<ReturnType<typeof setTimeout> | null>( null );
  const maxDateForTimePicker = new Date( );
  maxDateForTimePicker.setHours( 24, 0, 0, 0 );

  React.useEffect( ( ) => ( ) => {
    if ( dismissTimer.current ) clearTimeout( dismissTimer.current );
  }, [] );

  // Every way out of the picker (confirm, cancel, backdrop) runs through here,
  // so this is where the quiet period starts.
  const _toggleDateTimePicker = ( ) => {
    setisTimeVisible( false );
    setIsDismissing( true );
    if ( dismissTimer.current ) clearTimeout( dismissTimer.current );
    dismissTimer.current = setTimeout( ( ) => setIsDismissing( false ), DISMISS_MS );
    toggleDateTimePicker( );
  };

  const isVisible = isDateTimePickerVisible && !isDismissing;

  if ( mode === "datetime" && isTimeVisible ) {
    return (
      <DateTimePicker
        display="spinner"
        customHeaderIOS={EmptyHeader}
        isDarkModeEnabled={false}
        themeVariant="light"
        isVisible={isVisible}
        maximumDate={new Date( )}
        mode="time"
        onCancel={_toggleDateTimePicker}
        onConfirm={selectedDate => {
          onDatePicked( selectedDate );
          _toggleDateTimePicker( );
        }}
        date={selectedDateNoTime}
      />
    );
  }

  if ( mode === "time" ) {
    return (
      <DateTimePicker
        display="spinner"
        customHeaderIOS={EmptyHeader}
        isDarkModeEnabled={false}
        themeVariant="light"
        isVisible={isVisible}
        mode="time"
        onCancel={_toggleDateTimePicker}
        onConfirm={selectedDate => {
          onDatePicked( selectedDate );
          _toggleDateTimePicker( );
        }}
        maximumDate={maxDateForTimePicker}
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
      onCancel={_toggleDateTimePicker}
      onConfirm={selectedDate => {
        if ( mode === "datetime" ) {
          setSelectedDateNoTime( selectedDateNoTime );
          setisTimeVisible( true );
        } else {
          onDatePicked( selectedDate );
          _toggleDateTimePicker( );
        }
      }}
      date={date || new Date( )}
    />
  );
};

export default DatePicker;
