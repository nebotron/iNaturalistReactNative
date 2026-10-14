import { INatIcon } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import type { ViewStyle } from "react-native";
import { getShadow } from "styles/global";
import colors from "styles/tailwindColors";

const ICON_DROP_SHADOW = getShadow( {
  offsetHeight: 1,
  shadowOpacity: 1,
  shadowRadius: 1,
} );

interface Props {
  accessibilityLabel: string;
  className?: string;
  size?: number;
  style?: ViewStyle;
  testID?: string;
}

const DuplicateUploadBadge = ( {
  accessibilityLabel,
  className = "absolute top-1 left-1 z-10",
  size = 16,
  style,
  testID,
}: Props ) => (
  <View
    accessibilityLabel={accessibilityLabel}
    className={className}
    style={[ICON_DROP_SHADOW, style]}
    testID={testID}
  >
    <INatIcon
      name="triangle-exclamation"
      color={colors.warningRed}
      size={size}
    />
  </View>
);

export default DuplicateUploadBadge;
