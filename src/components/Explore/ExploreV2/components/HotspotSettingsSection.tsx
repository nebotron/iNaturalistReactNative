import { Body2, Heading4 } from "components/SharedComponents";
import { TextInput, View } from "components/styledComponents";
import React, { useState } from "react";
import { useTranslation } from "sharedHooks";
import type { HotspotSettings } from "stores/createLayoutSlice";
import useStore from "stores/useStore";

const FIELDS: {
  key: keyof HotspotSettings;
  label: string;
  min: number;
  decimal?: boolean;
}[] = [
  {
    key: "hotspotClusterRadiusKm", label: "Hotspot-cluster-radius-km", min: 0.1, decimal: true,
  },
  { key: "hotspotMaxDetourCandidates", label: "Hotspot-max-detour-candidates", min: 1 },
  { key: "hotspotObsPerPage", label: "Hotspot-obs-per-page", min: 1 },
  { key: "hotspotParkingMinutes", label: "Hotspot-parking-minutes", min: 0 },
  { key: "hotspotBboxPaddingKm", label: "Hotspot-bbox-padding-km", min: 0 },
];

interface FieldProps {
  field: typeof FIELDS[number];
}

const HotspotSettingField = ( { field }: FieldProps ) => {
  const { t } = useTranslation( );
  const value = useStore( state => state.layout.hotspotSettings[field.key] );
  const setHotspotSetting = useStore( state => state.layout.setHotspotSetting );
  const [text, setText] = useState( String( value ) );

  const onBlur = ( ) => {
    const parsed = field.decimal
      ? parseFloat( text )
      : parseInt( text, 10 );
    const next = Number.isNaN( parsed )
      ? value
      : Math.max( field.min, parsed );
    setText( String( next ) );
    setHotspotSetting( field.key, next );
  };

  return (
    <>
      <Body2 className="mb-2">{t( field.label )}</Body2>
      <TextInput
        accessibilityLabel={t( field.label )}
        className="border border-lightGray h-10 rounded-xl px-3 mb-5 text-base"
        keyboardType={field.decimal
          ? "decimal-pad"
          : "number-pad"}
        onBlur={onBlur}
        onChangeText={setText}
        returnKeyType="done"
        value={text}
      />
    </>
  );
};

const HotspotSettingsSection = ( ) => {
  const { t } = useTranslation( );
  return (
    <View>
      <Heading4 className="mb-5">{t( "HOTSPOT-SETTINGS" )}</Heading4>
      {FIELDS.map( field => <HotspotSettingField key={field.key} field={field} /> )}
    </View>
  );
};

export default HotspotSettingsSection;
