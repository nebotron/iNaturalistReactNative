import RotatableIconWrapper from "components/Camera/RotatableIconWrapper";
import TransparentCircleButton from "components/SharedComponents/Buttons/TransparentCircleButton";
import React from "react";
import type { ViewStyle } from "react-native";
import { useTranslation } from "sharedHooks";

interface Props {
  rotatableAnimatedStyle: ViewStyle;
  toggleMacro: ( ) => void;
  macroMode: boolean;
}

const Macro = ( {
  rotatableAnimatedStyle,
  toggleMacro,
  macroMode,
}: Props ) => {
  const { t } = useTranslation( );

  return (
    <RotatableIconWrapper
      rotatableAnimatedStyle={rotatableAnimatedStyle}
      containerClass="m-0 border-0"
    >
      <TransparentCircleButton
        onPress={toggleMacro}
        testID={macroMode
          ? "macro-button-on"
          : "macro-button-off"}
        accessibilityLabel={t( "Macro-mode" )}
        accessibilityHint={macroMode
          ? t( "Disable-macro-mode" )
          : t( "Enable-macro-mode" )}
        icon="iconic-plantae"
        optionalClasses={macroMode
          ? "border-2 border-inatGreen"
          : undefined}
      />
    </RotatableIconWrapper>
  );
};

export default Macro;
