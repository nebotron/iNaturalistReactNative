import { Body4, INatIcon, UserIcon } from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import NotificationsIconContainer from "navigation/BottomTabNavigator/NotificationsIconContainer";
import type { PropsWithChildren } from "react";
import * as React from "react";
import type { GestureResponderEvent } from "react-native";
import colors from "styles/tailwindColors";

interface IconFrameProps extends PropsWithChildren{
  testID: string;
}

interface Props {
  testID: string;
  icon: string;
  onPress: () => void;
  userIconUri?: string;
  accessibilityLabel: string;
  accessibilityHint?: string;
  active: boolean;
  size: number;
}

const IconFrame = ( { children, testID }: IconFrameProps ) => (
  <View
    className="h-9 w-9 items-center justify-center"
    testID={testID}
  >
    {children}
  </View>
);

// Ignore accidental brushes: touches that slide rather than tap
const MAX_TAP_MOVEMENT = 10;

const NavButton = ( {
  testID,
  size,
  icon,
  onPress,
  userIconUri,
  active,
  accessibilityLabel,
  accessibilityHint,
}: Props ) => {
  const pressStart = React.useRef<{ x: number; y: number } | null>( null );
  const onPressIn = ( e?: GestureResponderEvent ) => {
    const ne = e?.nativeEvent;
    pressStart.current = ne
      ? { x: ne.pageX, y: ne.pageY }
      : null;
  };
  const onDeliberatePress = ( e?: GestureResponderEvent ) => {
    const start = pressStart.current;
    const ne = e?.nativeEvent;
    if ( start && ne
      && Math.hypot( ne.pageX - start.x, ne.pageY - start.y ) > MAX_TAP_MOVEMENT ) return;
    onPress( );
  };
  let iconComponent;
  if ( userIconUri ) {
    iconComponent = (
      <IconFrame testID={testID}>
        <UserIcon uri={userIconUri} active={active} size={size} />
      </IconFrame>
    );
  } else if ( icon === "notifications-bell" ) {
    iconComponent = (
      <IconFrame testID={testID}>
        <NotificationsIconContainer
          icon={icon}
          size={size}
          active={active}
        />
      </IconFrame>
    );
  } else {
    iconComponent = (
      <IconFrame testID={testID}>
        <INatIcon
          name={icon}
          color={active
            ? colors.inatGreen
            : colors.darkGray}
          size={size}
        />
      </IconFrame>
    );
  }

  return (
    <Pressable
      className="min-h-[44px] min-w-[44px] items-center justify-end"
      onPressIn={onPressIn}
      onPress={onDeliberatePress}
      pressRetentionOffset={0}
      key={`NavButton-${accessibilityLabel}`}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="tab"
      accessibilityHint={accessibilityHint}
      accessibilityState={{
        selected: active,
        disabled: false,
      }}
    >
      {iconComponent}
      <Body4
        numberOfLines={1}
        className={active
          ? "mt-[2px] text-inatGreen"
          : "mt-[2px] text-darkGray"}
        maxFontSizeMultiplier={1.2}
      >
        {accessibilityLabel}
      </Body4>
    </Pressable>
  );
};

export default NavButton;
