import { Body2, Heading4, INatIconButton } from "components/SharedComponents";
import {
  KeyboardAvoidingView, Modal, ScrollView, TextInput, View,
} from "components/styledComponents";
import type { TFunction } from "i18next";
import React, { useState } from "react";
import { Platform, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "sharedHooks";
import useKeyboardInfo from "sharedHooks/useKeyboardInfo";
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
  { key: "hotspotMaxPlanCandidates", label: t => t( "Hotspot-plan-candidates" ), min: 1 },
  { key: "hotspotTimeStepMinutes", label: t => t( "Hotspot-time-step-minutes" ), min: 1 },
  { key: "hotspotRecentAddresses", label: t => t( "Hotspot-recent-addresses" ), min: 0 },
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
      <TextInput
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
  const { top, bottom } = useSafeAreaInsets( );
  const { keyboardShown } = useKeyboardInfo( );
  const bottomPadding = keyboardShown
    ? 0
    : bottom;
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

  // A plain modal rather than the shared bottom sheet: the sheet library
  // lifts the whole sheet by the keyboard's height, which put the header and
  // its close button under the status bar and left a blank strip above the
  // keyboard. Here the header stays put, the fields scroll beneath it, and
  // the card fits between the status bar and the keyboard.
  return (
    <Modal
      animationType="slide"
      onRequestClose={close}
      transparent
      visible
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios"
          ? "padding"
          : undefined}
        className="flex-1 justify-end bg-black/50"
        style={{ paddingTop: top + 8 }}
      >
        <Pressable
          accessibilityLabel={t( "Close" )}
          accessibilityRole="button"
          className="absolute inset-0"
          onPress={close}
        />
        <View
          className="bg-white rounded-t-3xl overflow-hidden shrink"
          // The home-indicator inset is only needed with the keyboard down
          style={{ paddingBottom: bottomPadding }}
        >
          <View className="pt-7 pb-3 mx-12">
            <Heading4 className="w-full text-center">
              {t( "HOTSPOT-SETTINGS" )}
            </Heading4>
          </View>
          <INatIconButton
            icon="close"
            onPress={close}
            size={19}
            className="absolute top-3.5 right-3"
            accessibilityLabel={t( "Close" )}
          />
          <ScrollView
            className="grow-0"
            keyboardShouldPersistTaps="handled"
          >
            <View className="px-7 pt-2 pb-2">
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
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

export default HotspotSettingsSheet;
