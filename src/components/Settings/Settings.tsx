import { useNavigation } from "@react-navigation/native";
import {
  Button,
  Heading4,
  ScrollViewWrapper,
  SwitchRow,
} from "components/SharedComponents";
import React, { useCallback } from "react";
import {
  View,
} from "react-native";
import {
  useCurrentUser,
  useLayoutPrefs,
  useTranslation,
} from "sharedHooks";

import AdvancedSettings from "./AdvancedSettings";
import LoggedInDefaultSettings from "./LoggedInDefaultSettings";
import UsbImportSetting from "./UsbImportSetting";

const Settings = ( ) => {
  const { t } = useTranslation();
  const currentUser = useCurrentUser( );
  const navigation = useNavigation( );
  const {
    isDefaultMode,
    setIsDefaultMode,
  } = useLayoutPrefs( );

  const handleValueChange = useCallback( ( newValue: boolean ) => {
    setIsDefaultMode( !newValue );
  }, [setIsDefaultMode] );

  // maybe there's a less confusing way to do this,
  // but this worked for my brain on a deadline
  const isAdvancedMode = !isDefaultMode;

  return (
    <ScrollViewWrapper>
      <View className="p-4">
        <Heading4 className="mb-[15px]">{t( "ADVANCED-SETTINGS" )}</Heading4>
        <SwitchRow
          testID="advanced-interface-switch"
          classNames="ml-[6px]"
          smallLabel
          value={isAdvancedMode}
          onValueChange={handleValueChange}
          label={t( "Advanced-Mode" )}
        />
        {isAdvancedMode && <AdvancedSettings />}
        {currentUser && <LoggedInDefaultSettings />}
        <UsbImportSetting />
        <Heading4 className="mt-[30px] mb-[15px]">{t( "PRIVACY-ZONE" )}</Heading4>
        <Button
          text={t( "Set-Up-Privacy-Zone" )}
          onPress={( ) => navigation.navigate( "PrivacyZone" )}
          testID="Settings.PrivacyZoneButton"
        />
      </View>
    </ScrollViewWrapper>
  );
};

export default Settings;
