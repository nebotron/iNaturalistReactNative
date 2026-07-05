import {
  Body2,
  RadioButtonRow,
  SwitchRow,
} from "components/SharedComponents";
import React from "react";
import {
  View,
} from "react-native";
import {
  useLayoutPrefs,
  useTranslation,
} from "sharedHooks";
import { SCREEN_AFTER_PHOTO_EVIDENCE } from "stores/createLayoutSlice";

const AdvancedSettings = ( ) => {
  const { t } = useTranslation();
  const {
    autoAdjustBrightness,
    setAutoAdjustBrightness,
    isAllAddObsOptionsMode,
    setIsAllAddObsOptionsMode,
    screenAfterPhotoEvidence,
    setScreenAfterPhotoEvidence,
  } = useLayoutPrefs();

  return (
    <>
      <View className="mt-[20px]">
        <Body2>{ t( "When-tapping-the-green-observation-button" ) }</Body2>
        <RadioButtonRow
          classNames="ml-[6px] mt-[15px]"
          testID="all-observation-options"
          smallLabel
          checked={isAllAddObsOptionsMode}
          onPress={() => setIsAllAddObsOptionsMode( true )}
          label={t( "All-observation-options--list" )}
        />
        <RadioButtonRow
          classNames="ml-[6px] mt-[15px]"
          smallLabel
          checked={!isAllAddObsOptionsMode}
          onPress={() => setIsAllAddObsOptionsMode( false )}
          label={t( "iNaturalist-AI-Camera" )}
        />
      </View>
      <View className="mt-[20px]">
        <Body2>{ t( "After-capturing-or-importing-photos-show" ) }</Body2>
        <RadioButtonRow
          classNames="ml-[6px] mt-[15px]"
          testID="suggestions-flow-mode"
          smallLabel
          checked={screenAfterPhotoEvidence === SCREEN_AFTER_PHOTO_EVIDENCE.SUGGESTIONS}
          onPress={() => setScreenAfterPhotoEvidence( SCREEN_AFTER_PHOTO_EVIDENCE.SUGGESTIONS )}
          label={t( "ID-Suggestions" )}
        />
        <RadioButtonRow
          classNames="ml-[6px] mt-[15px]"
          smallLabel
          checked={screenAfterPhotoEvidence === SCREEN_AFTER_PHOTO_EVIDENCE.OBS_EDIT}
          onPress={() => setScreenAfterPhotoEvidence( SCREEN_AFTER_PHOTO_EVIDENCE.OBS_EDIT )}
          label={t( "Edit-Observation" )}
        />
        <RadioButtonRow
          classNames="ml-[6px] mt-[15px]"
          smallLabel
          checked={screenAfterPhotoEvidence === SCREEN_AFTER_PHOTO_EVIDENCE.MATCH}
          onPress={() => setScreenAfterPhotoEvidence( SCREEN_AFTER_PHOTO_EVIDENCE.MATCH )}
          label={t( "Match-Screen" )}
        />
      </View>
      <View className="mt-[20px]">
        <SwitchRow
          testID="auto-adjust-brightness-switch"
          classNames="ml-[6px]"
          smallLabel
          value={autoAdjustBrightness}
          onValueChange={setAutoAdjustBrightness}
          label={t( "Auto-Adjust-Brightness" )}
        />
      </View>
    </>
  );
};

export default AdvancedSettings;
