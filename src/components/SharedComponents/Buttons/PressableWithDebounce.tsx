import {
  Pressable,
} from "components/styledComponents";
import type { PropsWithChildren } from "react";
import React, { useEffect, useRef, useState } from "react";
import type { AccessibilityRole, GestureResponderEvent, ViewStyle } from "react-native";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "PressableWithDebounce" );

interface Props extends PropsWithChildren {
  accessibilityHint?: string;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  style?: ViewStyle;
  className?: string;
  onPress: ( _event?: GestureResponderEvent ) => void;
  testID?: string;
  disabled: boolean;
  debounceTime?: number;
  preventMultipleTaps?: boolean;
}

const PressableWithDebounce = ( {
  accessibilityHint,
  accessibilityLabel,
  accessibilityRole,
  style,
  className,
  testID,
  onPress,
  disabled,
  children,
  debounceTime = 400,
  preventMultipleTaps = true,
}: Props ) => {
  const [isProcessing, setIsProcessing] = useState( false );
  const onPressRef = useRef( onPress );
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>( null );

  onPressRef.current = onPress;

  useEffect( ( ) => ( ) => {
    if ( resetTimer.current ) { clearTimeout( resetTimer.current ); }
  }, [] );

  const handleOnPress = ( event?: GestureResponderEvent ) => {
    if ( !preventMultipleTaps ) {
      onPressRef.current( event );
      return;
    }

    if ( isProcessing ) return;

    setIsProcessing( true );

    // Scheduled before the handler runs: see the same fix in Button.tsx. A
    // handler that throws used to skip this and leave isProcessing latched on,
    // which the guard above then turns into a Pressable that ignores every
    // later tap for as long as the screen stays mounted.
    resetTimer.current = setTimeout( ( ) => {
      resetTimer.current = null;
      setIsProcessing( false );
    }, debounceTime );

    try {
      onPressRef.current( event );
    } catch ( error ) {
      logger.errorWithExtra( "pressable_press_threw", error, { testID: testID ?? "unknown" } );
      throw error;
    }
  };

  const isDisabled = disabled || ( preventMultipleTaps && isProcessing );

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ disabled }}
      style={style}
      className={className}
      testID={testID}
      onPress={handleOnPress}
      disabled={isDisabled}
    >
      {children}
    </Pressable>
  );
};

export default PressableWithDebounce;
