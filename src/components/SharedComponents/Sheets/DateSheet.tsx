import RNDateTimePicker from "@react-native-community/datetimepicker";
import {
  BottomSheet,
  Button,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, { useState } from "react";
import useTranslation from "sharedHooks/useTranslation";

interface Props {
  onPressClose: ( ) => void;
  confirm: ( selection: Date ) => void;
  headerText: string;
  date?: Date;
  maximumDate?: Date;
  insideModal?: boolean;
}

interface DateSheetContentProps {
  confirm: ( selection: Date ) => void;
  date?: Date;
  maximumDate?: Date;
}

// Note re: keeping selection state below the BottomSheetModal's portal boundary: see the
// matching comment in PickerSheet.tsx (MOB-1165) - the native picker races the portal the
// same way if it owns state above that boundary.
const DateSheetContent = ( { confirm, date, maximumDate }: DateSheetContentProps ) => {
  const { t } = useTranslation( );
  const [selection, setSelection] = useState( date ?? new Date( ) );

  return (
    <View className="p-5">
      <RNDateTimePicker
        value={selection}
        mode="date"
        display="spinner"
        maximumDate={maximumDate}
        onChange={( _event, selectedDate ) => {
          if ( selectedDate ) setSelection( selectedDate );
        }}
      />
      <Button
        level="primary"
        text={t( "CONFIRM" )}
        onPress={( ) => confirm( selection )}
        className="mt-[15px]"
        accessibilityLabel={t( "CONFIRM" )}
      />
    </View>
  );
};

// Renders the native date picker inline inside a BottomSheet instead of using
// react-native-modal-datetime-picker, which presents its own native Modal. Nesting that
// inside a screen already shown in a Modal (e.g. Explore's FilterModal) is a known React
// Native issue where closing the inner modal can leave the outer one unresponsive to touches.
const DateSheet = ( {
  onPressClose,
  confirm,
  headerText,
  date,
  maximumDate,
  insideModal,
}: Props ) => (
  <BottomSheet
    onPressClose={onPressClose}
    headerText={headerText}
    insideModal={insideModal}
    scrollEnabled={false}
    enablePanDownToClose={false}
    enableContentPanningGesture={false}
  >
    <DateSheetContent
      confirm={confirm}
      date={date}
      maximumDate={maximumDate}
    />
  </BottomSheet>
);

export default DateSheet;
