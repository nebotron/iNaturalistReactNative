import { useNavigation } from "@react-navigation/native";
import {
  Button,
  Heading4,
  ScrollViewWrapper,
} from "components/SharedComponents";
import type { TabStackScreenProps } from "navigation/types";
import React from "react";
import {
  View,
} from "react-native";
import changeLanguage from "sharedHelpers/changeLanguage";
import {
  useCurrentUser,
  useTranslation,
} from "sharedHooks";

import AdvancedSettings from "./AdvancedSettings";
import LanguageSetting from "./LanguageSetting";
import LoggedInDefaultSettings from "./LoggedInDefaultSettings";
import UsbImportSetting from "./UsbImportSetting";

const Settings = ( ) => {
  const { t } = useTranslation();
  const currentUser = useCurrentUser( );
  const navigation = useNavigation<TabStackScreenProps<"Settings">["navigation"]>( );
  return (
    <ScrollViewWrapper>
      <View className="p-4">
        <Heading4 className="mb-[15px]">{t( "ADVANCED-SETTINGS" )}</Heading4>
        <AdvancedSettings />
        {currentUser
          ? <LoggedInDefaultSettings onLocaleChange={changeLanguage} />
          : (
            <View className="mt-[30px]">
              <LanguageSetting onChange={changeLanguage} />
            </View>
          )}
        <UsbImportSetting />
        <Button
          className="mt-[30px]"
          level="neutral"
          text={t( "TUNABLE-PARAMETERS" )}
          onPress={( ) => navigation.navigate( "TunableParams" )}
        />
      </View>
    </ScrollViewWrapper>
  );
};

export default Settings;
