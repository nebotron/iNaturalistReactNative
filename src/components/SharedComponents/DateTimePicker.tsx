import * as React from "react";
import DateTimePicker from "react-native-modal-datetime-picker";

interface Props {
  date?: Date;
  toggleDateTimePicker: () => void;
  onDatePicked: ( date: Date ) => void;
  isDateTimePickerVisible: boolean;
}

// using component from Seek: https://github.com/inaturalist/SeekReactNative/blob/64ae3df185fffe751aff40ab17e3ff2dd8a74e42/components/UIComponents/DateTimePicker.js

const EmptyHeader = ( ) => null;

const DatePicker = ( {
  date,
  isDateTimePickerVisible,
  onDatePicked,
  toggleDateTimePicker,
}: Props ) => (
  <DateTimePicker
    display="spinner"
    customHeaderIOS={EmptyHeader}
    isDarkModeEnabled={false}
    themeVariant="light"
    isVisible={isDateTimePickerVisible}
    maximumDate={new Date( )}
    mode="date"
    onCancel={toggleDateTimePicker}
    onConfirm={selectedDate => {
      onDatePicked( selectedDate );
      toggleDateTimePicker( );
    }}
    date={date || new Date( )}
  />
);

export default DatePicker;
