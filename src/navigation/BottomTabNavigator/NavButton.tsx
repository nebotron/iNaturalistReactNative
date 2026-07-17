import { Body4, INatIcon, UserIcon } from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import NotificationsIconContainer from "navigation/BottomTabNavigator/NotificationsIconContainer";
import type { PropsWithChildren } from "react";
import * as React from "react";
import type { GestureResponderEvent } from "react-native";
import colors from "styles/tailwindColors";

// Accidental contact from a palm or the base of the thumb tends to register
// as several simultaneous touch points and/or as a very brief graze, whereas
// a deliberate tab tap is a single, sustained touch. Ignoring multi-touch
// presses and grazes shorter than this threshold rejects most accidental
// taps without adding perceptible latency to real taps.
const MIN_PRESS_DURATION_MS = 60;

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
  const pressStartRef = React.useRef<number | null>( null );
  const rejectedRef = React.useRef( false );

  const handlePressIn = React.useCallback( ( event: GestureResponderEvent ) => {
    // A palm covers a broad area and registers as more than one active touch
    const touchCount = event?.nativeEvent?.touches?.length ?? 1;
    rejectedRef.current = touchCount > 1;
    pressStartRef.current = Date.now( );
  }, [] );

  const handlePress = React.useCallback( ( ) => {
    if ( rejectedRef.current ) return;
    const start = pressStartRef.current;
    // Only enforce the duration guard when we actually observed the touch
    // begin, so programmatic and accessibility activations still work
    if ( start != null && Date.now( ) - start < MIN_PRESS_DURATION_MS ) return;
    onPress( );
  }, [onPress] );

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
      onPressIn={handlePressIn}
      onPress={handlePress}
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
