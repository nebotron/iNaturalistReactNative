import classnames from "classnames";
import {
  Body3,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import useTranslation from "sharedHooks/useTranslation";
import { getShadow } from "styles/global";

const DROP_SHADOW = getShadow( );

interface Props {
  accuracyTest: "pass" | "acceptable" | "fail";
}

const WarningText = ( { accuracyTest }: Props ) => {
  const { t } = useTranslation( );

  // Only warn when accuracy is too imprecise to be useful. The
  // "zoom in as much as possible" nudge for merely-acceptable accuracy has
  // been removed.
  if ( accuracyTest !== "fail" ) {
    return null;
  }

  return (
    <View
      pointerEvents="none"
      className="p-4 rounded-xl bg-warningRed"
      style={DROP_SHADOW}
    >
      <Body3 className="text-white text-center">
        {t( "Location-accuracy-is-too-imprecise" )}
      </Body3>
    </View>
  );
};

export default WarningText;
