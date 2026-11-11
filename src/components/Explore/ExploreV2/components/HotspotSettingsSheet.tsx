import { Body2, BottomSheet } from "components/SharedComponents";
import { BottomSheetTextInput, View } from "components/styledComponents";
import type { TFunction } from "i18next";
import React, { useState } from "react";
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

type Field = typeof FIELDS[number];

// The value a field's text stands for, or the saved value if it isn't a number
const parseField = ( field: Field, text: string, saved: number ) => {
  const parsed = field.decimal
    ? parseFloat( text )
    : parseInt( text, 10 );
  return Number.isNaN( parsed )
    ? saved
    : Math.max( field.min, parsed );
};

interface FieldProps {
  field: Field;
  text: string;
  onChangeText: ( text: string ) => void;
  onBlur: ( ) => void;
}

const HotspotSettingField = ( {
  field, text, onChangeText, onBlur,
}: FieldProps ) => {
  const { t } = useTranslation( );
  return (
    <>
      <Body2 className="mb-2">{field.label( t )}</Body2>
      {/* BottomSheetTextInput lets the sheet rise above the keyboard */}
      <BottomSheetTextInput
        accessibilityLabel={field.label( t )}
        className="border border-lightGray h-10 rounded-xl px-3 mb-5 text-base"
        keyboardType={field.decimal
          ? "decimal-pad"
          : "number-pad"}
        onBlur={onBlur}
        onChangeText={onChangeText}
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
  const saved = useStore( state => state.layout.hotspotSettings );
  const setHotspotSetting = useStore( state => state.layout.setHotspotSetting );
  // Edits stay here until the sheet closes, so the hotspot search, which
  // reruns whenever the saved settings change, runs once with all of them.
  const [drafts, setDrafts] = useState<Record<keyof HotspotSettings, string>>(
    ( ) => Object.fromEntries(
      FIELDS.map( field => [field.key, String( saved[field.key] )] ),
    ) as Record<keyof HotspotSettings, string>,
  );

  const setDraft = ( key: keyof HotspotSettings, text: string ) => {
    setDrafts( prev => ( { ...prev, [key]: text } ) );
  };

  const close = ( ) => {
    FIELDS.forEach( field => {
      const next = parseField( field, drafts[field.key], saved[field.key] );
      if ( next !== saved[field.key] ) setHotspotSetting( field.key, next );
    } );
    onPressClose( );
  };

  return (
    <BottomSheet
      headerText={t( "HOTSPOT-SETTINGS" )}
      keyboardShouldPersistTaps="handled"
      onPressClose={close}
    >
      <View className="p-7 pt-2">
        {FIELDS.map( field => (
          <HotspotSettingField
            key={field.key}
            field={field}
            text={drafts[field.key]}
            onChangeText={text => setDraft( field.key, text )}
            // Show the value that will be used, e.g. the minimum for one below it
            onBlur={( ) => setDraft(
              field.key,
              String( parseField( field, drafts[field.key], saved[field.key] ) ),
            )}
          />
        ) )}
      </View>
    </BottomSheet>
  );
};

export default HotspotSettingsSheet;
