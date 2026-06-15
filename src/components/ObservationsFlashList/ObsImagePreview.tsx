import type { ArgumentArray } from "classnames";
import classNames from "classnames";
import { INatIcon, PhotoCount } from "components/SharedComponents";
import { LinearGradient, View } from "components/styledComponents";
import type { PropsWithChildren } from "react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { getShadow } from "styles/global";
import colors from "styles/tailwindColors";

import ObsImage from "./ObsImage";

const ICON_DROP_SHADOW = getShadow( {
  offsetHeight: 1,
  shadowOpacity: 1,
  shadowRadius: 1,
} );

interface Props extends PropsWithChildren {
  autoDetectSubject?: boolean;
  className?: string;
  hasSound?: boolean;
  height?: string;
  hidePhotoCount?: boolean;
  iconicTaxonName?: string;
  isBackground?: boolean;
  isMultiplePhotosTop?: boolean;
  isSmall?: boolean;
  obsPhotosCount?: number;
  opaque?: boolean;
  photos?: ( { uri: string } | null )[];
  selectable?: boolean;
  selected?: boolean;
  source?: {
    uri: string;
  };
  style?: ViewStyle;
  testID?: string;
  useShortGradient?: boolean;
  white?: boolean;
  width?: string;
  hideGradientOverlay?: boolean;
  squareCorners?: boolean;
}

const getBorderRadiusClass = (
  squareCorners: boolean,
  isSmall: boolean,
): string | null => {
  if ( squareCorners ) {
    return null;
  }
  return isSmall
    ? "rounded-lg"
    : "rounded-2xl";
};

const ObsImagePreview = ( {
  autoDetectSubject = false,
  children,
  className,
  hasSound = false,
  height = "h-[62px]",
  hidePhotoCount,
  iconicTaxonName,
  isBackground = true,
  isMultiplePhotosTop = false,
  isSmall = false,
  obsPhotosCount = 0,
  opaque = false,
  photos,
  selectable = false,
  selected = false,
  source,
  style,
  testID,
  useShortGradient,
  white = false,
  width = "w-[62px]",
  hideGradientOverlay = false,
  squareCorners = false,
}: Props ) => {
  const [currentIndex, setCurrentIndex] = useState( 0 );
  const borderRadius = getBorderRadiusClass( squareCorners, isSmall );

  useEffect( ( ) => {
    setCurrentIndex( 0 );
  }, [photos] );

  const goToPrev = useCallback( ( ) => {
    setCurrentIndex( i => Math.max( 0, i - 1 ) );
  }, [] );

  const goToNext = useCallback( ( ) => {
    if ( !photos ) return;
    setCurrentIndex( i => Math.min( photos.length - 1, i + 1 ) );
  }, [photos] );

  // Capture horizontal swipes exclusively: activates after 10px horizontal
  // movement. failOffsetY is intentionally generous (10px) so diagonal swipes
  // still trigger the carousel rather than silently failing; vertical scrolling
  // in the parent list still works because the gesture fails once vertical
  // movement exceeds the threshold and hands control back to the scroll view.
  const swipeGesture = useMemo(
    ( ) => Gesture.Pan( )
      .runOnJS( true )
      .activeOffsetX( [-10, 10] )
      .failOffsetY( [-10, 10] )
      .onEnd( ( { translationX, velocityX } ) => {
        const isSwipeLeft = translationX < -30 || ( translationX < 0 && velocityX < -200 );
        const isSwipeRight = translationX > 30 || ( translationX > 0 && velocityX > 200 );
        if ( isSwipeLeft ) {
          goToNext( );
        } else if ( isSwipeRight ) {
          goToPrev( );
        }
      } ),
    [goToNext, goToPrev],
  );

  const imageClassNames: ArgumentArray = [
    "overflow-hidden",
    "relative",
  ];

  if ( squareCorners ) {
    imageClassNames.push( "w-full", "h-full" );
  } else {
    imageClassNames.push( "max-h-[210px]", height, width );
  }

  if ( className ) {
    imageClassNames.push( className );
  }

  if ( borderRadius ) {
    imageClassNames.push( borderRadius );
  }

  const renderPhotoCount = useCallback( ( ) => {
    if ( obsPhotosCount <= 1 || hidePhotoCount ) return null;

    if ( isSmall ) {
      return (
        <View
          className={classNames(
            "absolute",
            "right-1",
            isMultiplePhotosTop
              ? "top-1"
              : "bottom-1",
          )}
          style={ICON_DROP_SHADOW}
        >
          <INatIcon name="photos-outline" color={colors.white} size={16} />
        </View>
      );
    }

    return (
      <View
        className={classNames(
          "absolute",
          "right-0",
          "p-2",
          isMultiplePhotosTop
            ? "top-0"
            : "bottom-0",
        )}
        style={ICON_DROP_SHADOW}
      >
        { obsPhotosCount !== 0
          && <PhotoCount count={obsPhotosCount} /> }
      </View>
    );
  }, [
    hidePhotoCount,
    isMultiplePhotosTop,
    isSmall,
    obsPhotosCount,
  ] );

  const renderSelectable = useCallback( ( ) => {
    if ( selectable ) {
      return (
        <View
          className={classNames(
            "flex items-center justify-center",
            "rounded-full",
            "absolute m-2.5 right-0",
            {
              "bg-white": selected,
              "w-[24px] h-[24px]": selected,
              "w-[24px] h-[24px] border-2 border-white": !selected,
            },
          )}
          style={ICON_DROP_SHADOW}
        >
          {selected && (
            <INatIcon name="checkmark" color={colors.darkGray} size={12} />
          )}
        </View>
      );
    }
    return null;
  }, [selectable, selected] );

  const renderGradient = useCallback( ( ) => {
    if ( hideGradientOverlay ) return null;
    if ( isSmall ) return null;
    if ( useShortGradient ) {
      return (
        <LinearGradient
          colors={["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0.6) 100%)"]}
          className="absolute w-full h-full"
          start={{ x: 0, y: 0.5 }}
          end={{ x: 0, y: 1 }}
        />
      );
    }
    return (
      <LinearGradient
        colors={["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0.5) 100%)"]}
        className="absolute w-full h-full"
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 0.75 }}
      />
    );
  }, [isSmall, useShortGradient, hideGradientOverlay] );

  const renderSoundIcon = useCallback( ( ) => {
    if ( !hasSound ) return null;

    if ( isSmall ) {
      return (
        <View
          className="absolute left-1 bottom-1"
          style={ICON_DROP_SHADOW}
        >
          <INatIcon name="sound" color={colors.white} size={16} />
        </View>
      );
    }

    return (
      <View
        className={classNames( "absolute left-0 top-0 p-1", {
          "p-2": !isSmall,
        } )}
        style={ICON_DROP_SHADOW}
      >
        <INatIcon name="sound" color={colors.white} size={18} />
      </View>
    );
  }, [hasSound, isSmall] );

  let content;

  if ( isSmall && ( obsPhotosCount === 0 && !source?.uri ) ) {
    imageClassNames.push( "justify-center", "items-center", "border-2" );
    if ( white ) imageClassNames.push( "border-white" );
  }

  const useCarousel = photos && photos.length > 1;
  const activeUri = useCarousel
    ? ( photos[currentIndex] ?? undefined )
    : source;

  if ( isSmall && obsPhotosCount === 0 && hasSound ) {
    content = <INatIcon name="sound" color={colors.darkGray} size={24} />;
  } else {
    content = (
      <>
        <ObsImage
          autoDetectSubject={autoDetectSubject}
          uri={activeUri}
          opaque={opaque}
          iconicTaxonName={iconicTaxonName}
          white={white}
          isBackground={isBackground}
          iconicTaxonIconSize={isSmall
            ? 22
            : 100}
        />
        {renderGradient( )}
        {renderSelectable( )}
        {renderPhotoCount( )}
        {renderSoundIcon( )}
        {children}
      </>
    );
  }

  const containerView = (
    <View
      className={classNames( imageClassNames )}
      style={style}
      testID={testID}
    >
      {content}
    </View>
  );

  if ( useCarousel ) {
    return (
      <GestureDetector gesture={swipeGesture}>
        {containerView}
      </GestureDetector>
    );
  }

  return containerView;
};

export default ObsImagePreview;
