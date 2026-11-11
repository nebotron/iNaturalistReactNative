import { Body2, BottomSheet } from "components/SharedComponents";
import { BottomSheetTextInput, View } from "components/styledComponents";
import type { TFunction } from "i18next";
import React, { useState } from "react";
import { Keyboard, Platform } from "react-native";
import { useTranslation } from "sharedHooks";
import type { HotspotSettings } from "stores/createLayoutSlice";
import useStore from "stores/useStore";

const FIELDS: {
  key: keyof HotspotSettings;
  // Literal t( ) calls, so the i18n unused-key check sees each key
  label: ( t: TFunction ) => string;
  min: number;
  decimal?: boolean;
}[] = [
  {
    key: "hotspotClusterRadiusKm",
    label: t => t( "Hotspot-cluster-radius-km" ),
    min: 0.1,
    decimal: true,
  },
  { key: "hotspotMaxDetourCandidates", label: t => t( "Hotspot-max-detour-candidates" ), min: 1 },
  { key: "hotspotObsPerPage", label: t => t( "Hotspot-obs-per-page" ), min: 1 },
  { key: "hotspotParkingMinutes", label: t => t( "Hotspot-parking-minutes" ), min: 0 },
  { key: "hotspotBboxPaddingKm", label: t => t( "Hotspot-bbox-padding-km" ), min: 0 },
];

interface FieldProps {
  field: typeof FIELDS[number];
  onDone: ( ) => void;
}

const HotspotSettingField = ( { field, onDone }: FieldProps ) => {
  const { t } = useTranslation( );
  const value = useStore( state => state.layout.hotspotSettings[field.key] );
  const setHotspotSetting = useStore( state => state.layout.setHotspotSetting );
  const [text, setText] = useState( String( value ) );

  const commit = ( ) => {
    const parsed = field.decimal
      ? parseFloat( text )
      : parseInt( text, 10 );
    const next = Number.isNaN( parsed )
      ? value
      : Math.max( field.min, parsed );
    setText( String( next ) );
    setHotspotSetting( field.key, next );
  };

  // iOS number and decimal pads have no return key, so there would be no Done
  let keyboardType: "numbers-and-punctuation" | "decimal-pad" | "number-pad" = field.decimal
    ? "decimal-pad"
    : "number-pad";
  if ( Platform.OS === "ios" ) keyboardType = "numbers-and-punctuation";

  // Done commits the value, which changes the search params and so reruns
  // the hotspot search, and closes the sheet so the new results are visible.
  const onSubmitEditing = ( ) => {
    commit( );
    Keyboard.dismiss( );
    onDone( );
  };

  return (
    <>
      <Body2 className="mb-2">{field.label( t )}</Body2>
      {/* BottomSheetTextInput lets the sheet rise above the keyboard */}
      <BottomSheetTextInput
        accessibilityLabel={field.label( t )}
        className="border border-lightGray h-10 rounded-xl px-3 mb-5 text-base"
        keyboardType={keyboardType}
        onBlur={commit}
        onChangeText={setText}
        onSubmitEditing={onSubmitEditing}
        returnKeyType="done"
        // Typing replaces the value instead of appending to it
        selectTextOnFocus
        value={text}
      />
    </>
  );
};

interface Props {
  onPressClose: ( ) => void;
}

const HotspotSettingsSheet = ( { onPressClose }: Props ) => {
  const { t } = useTranslation( );
  return (
    <BottomSheet
      headerText={t( "HOTSPOT-SETTINGS" )}
      keyboardShouldPersistTaps="handled"
      onPressClose={onPressClose}
    >
      <View className="p-7 pt-2">
        {FIELDS.map( field => (
          <HotspotSettingField key={field.key} field={field} onDone={onPressClose} />
        ) )}
      </View>
    </BottomSheet>
  );
};

export default HotspotSettingsSheet;
