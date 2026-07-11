import {
  Body2,
  RadioButtonRow,
} from "components/SharedComponents";
import React from "react";
import {
  View,
} from "react-native";
import {
  useLayoutPrefs,
  useTranslation,
} from "sharedHooks";
import { AUTO_BRIGHTNESS_MODE, SCREEN_AFTER_PHOTO_EVIDENCE } from "stores/createLayoutSlice";

const AdvancedSettings = ( ) => {
  const { t } = useTranslation();
  const {
    autoBrightnessMode,
    setAutoBrightnessMode,
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
        <Body2>{ t( "Auto-Adjust-Brightness" ) }</Body2>
        <RadioButtonRow
          classNames="ml-[6px] mt-[15px]"
          testID="auto-brightness-off"
          smallLabel
          checked={autoBrightnessMode === AUTO_BRIGHTNESS_MODE.OFF}
          onPress={() => setAutoBrightnessMode( AUTO_BRIGHTNESS_MODE.OFF )}
          label={t( "Auto-Brightness-Off" )}
        />
        <RadioButtonRow
          classNames="ml-[6px] mt-[15px]"
          testID="auto-brightness-multiply"
          smallLabel
          checked={autoBrightnessMode === AUTO_BRIGHTNESS_MODE.MULTIPLY}
          onPress={() => setAutoBrightnessMode( AUTO_BRIGHTNESS_MODE.MULTIPLY )}
          label={t( "Auto-Brightness-Multiply" )}
        />
        <RadioButtonRow
          classNames="ml-[6px] mt-[15px]"
          testID="auto-brightness-gamma"
          smallLabel
          checked={autoBrightnessMode === AUTO_BRIGHTNESS_MODE.GAMMA}
          onPress={() => setAutoBrightnessMode( AUTO_BRIGHTNESS_MODE.GAMMA )}
          label={t( "Auto-Brightness-Gamma" )}
        />
      </View>
    </>
  );
};

export default AdvancedSettings;
