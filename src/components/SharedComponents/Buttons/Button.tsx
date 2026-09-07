import { tailwindFontBold } from "appConstants/fontFamilies";
import classnames from "classnames";
import { ActivityIndicator, Heading4, INatIcon } from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React, { useEffect, useRef, useState } from "react";
import type { AccessibilityRole, GestureResponderEvent, ViewStyle } from "react-native";
import { log } from "sharedHelpers/logger";
import colors from "styles/tailwindColors";

const logger = log.extend( "Button" );

interface ButtonProps {
  accessibilityHint?: string;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  style?: ViewStyle;
  className?: string;
  disabled?: boolean;
  forceDark?: boolean;
  icon?: string;
  iconPosition?: string;
  level?: string;
  loading?: boolean;
  onPress: ( _event?: GestureResponderEvent ) => void;
  testID?: string;
  text: string;
  dropdown?: boolean;
  maxFontSizeMultiplier?: number;
  adjustsFontSizeToFit?: boolean;
  debounceTime?: number;
  preventMultipleTaps?: boolean;
}

const setStyles = ( {
  className,
  disabled,
  forceDark,
  isFocus,
  isPrimary,
  isWarning,
}: {
  className?: string;
  disabled?: boolean;
  forceDark?: boolean;
  isFocus: boolean;
  isPrimary: boolean;
  isWarning: boolean;
} ) => {
  const buttonClasses = [
    "max-w-[500px]",
    "active:opacity-75",
    "flex-row",
    "items-center",
    "justify-center",
    "px-[10px]",
    "py-[13px]",
    "rounded-lg",
    tailwindFontBold,
  ];
  const textClasses = [
    "text-center",
    disabled
      ? "text-white/50"
      : "text-white",
  ];

  if ( className ) {
    buttonClasses.push( className );
  }

  if ( isWarning ) {
    buttonClasses.push( disabled
      ? "bg-warningRedDisabled"
      : "bg-warningRed" );
  } else if ( isPrimary ) {
    if ( forceDark ) {
      buttonClasses.push( disabled
        ? "bg-mediumGray"
        : "bg-white" );
      textClasses.push( disabled
        ? "text-black/50"
        : "text-black" );
    } else {
      buttonClasses.push( disabled
        ? "bg-darkGrayDisabled"
        : "bg-darkGray" );
      textClasses.push( disabled
        ? "text-white/50"
        : "text-white" );
    }
  } else if ( isFocus ) {
    if ( forceDark ) {
      buttonClasses.push( disabled
        ? "bg-inatGreenDisabledDark"
        : "bg-inatGreen" );
    } else {
      buttonClasses.push( disabled
        ? "bg-inatGreenDisabled"
        : "bg-inatGreen" );
    }
  } else {
    buttonClasses.push( "border border-[3px]" );
    buttonClasses.push( disabled
      ? "border-darkGrayDisabled"
      : "border-darkGray bg-white" );
    textClasses.push( disabled
      ? "text-darkGrayDisabled"
      : "text-darkGray" );
  }

  return { buttonClasses, textClasses };
};

const activityIndicatorColor = ( {
  isPrimary, isWarning, isFocus,
}: {
  isPrimary: boolean;
  isWarning: boolean;
  isFocus: boolean;
} ) => {
  if ( isPrimary ) {
    return colors.white;
  }
  if ( isFocus ) {
    return colors.white;
  }
  if ( isWarning ) {
    return colors.white;
  }
  // Default color of ActivityIndicator is primary anyways, but we need to return something
  return colors.darkGray;
};

const Button = ( {
  accessibilityHint,
  accessibilityLabel,
  accessibilityRole,
  style,
  className,
  disabled = false,
  forceDark,
  icon,
  iconPosition = "left",
  level = "neutral",
  loading,
  onPress,
  testID,
  text,
  dropdown,
  maxFontSizeMultiplier = 1.5,
  adjustsFontSizeToFit = false,
  debounceTime = 300,
  preventMultipleTaps = true,
}: ButtonProps ) => {
  const [isProcessing, setIsProcessing] = useState( false );
  const onPressRef = useRef( onPress );
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>( null );

  onPressRef.current = onPress;

  useEffect( ( ) => ( ) => {
    if ( resetTimer.current ) { clearTimeout( resetTimer.current ); }
  }, [] );

  const isPrimary = level === "primary";
  const isWarning = level === "warning";
  const isFocus = level === "focus";
  const isNeutral = !isPrimary && !isWarning && !isFocus;
  const { buttonClasses, textClasses } = setStyles( {
    className,
    disabled,
    forceDark,
    isFocus,
    isPrimary,
    isWarning,
  } );

  const handlePress = ( event?: GestureResponderEvent ) => {
    if ( !preventMultipleTaps ) {
      return onPressRef.current( event );
    }

    setIsProcessing( true );
    // Schedule the re-enable *before* running the handler, not after. A handler
    // that throws — reading a Realm object the write behind it just
    // invalidated, say — used to skip this line entirely and leave the button
    // disabled for as long as its screen stayed mounted, which for a screen
    // sitting in the navigation stack means until the app is restarted. React
    // error boundaries don't see throws from event handlers, so nothing on
    // screen said why the button had stopped answering taps.
    resetTimer.current = setTimeout( ( ) => {
      resetTimer.current = null;
      setIsProcessing( false );
    }, debounceTime );

    try {
      onPressRef.current( event );
    } catch ( error ) {
      // Rethrown so dev builds still redbox; logged because in a release build
      // this is otherwise completely silent.
      logger.errorWithExtra( "button_press_threw", error, { text } );
      throw error;
    }
    return null;
  };

  const isDisabled = disabled || ( preventMultipleTaps && isProcessing );

  return (
    <Pressable
      style={style}
      onPress={handlePress}
      className={classnames( buttonClasses )}
      disabled={isDisabled}
      testID={testID}
      // has no accessibilityLabel prop because then the button text is read as label
      accessibilityRole={accessibilityRole || "button"}
      accessibilityState={{ disabled: isDisabled }}
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
    >
      {loading && (
        <ActivityIndicator
          size={18}
          className="mr-3 absolute right-0"
          color={!isNeutral
            ? activityIndicatorColor( {
              isPrimary, isWarning, isFocus,
            } )
            : undefined}
        />
      )}
      {( icon && iconPosition === "left" ) && (
        <View className="mr-2">
          {icon}
        </View>
      )}
      <Heading4
        className={classnames( textClasses )}
        testID={`${testID || "RNButton"}.text`}
        maxFontSizeMultiplier={maxFontSizeMultiplier}
        adjustsFontSizeToFit={adjustsFontSizeToFit}
        numberOfLines={3}
      >
        {text}
      </Heading4>
      {( icon && iconPosition === "right" ) && (
        <View className="ml-4">
          {icon}
        </View>
      )}
      {dropdown && (
        <View className="ml-2 mb-1">
          <INatIcon
            name="caret"
            size={10}
          />
        </View>
      )}
    </Pressable>
  );
};

export default Button;
