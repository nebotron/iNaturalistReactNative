import RotatableIconWrapper from "components/Camera/RotatableIconWrapper";
import { Image, Pressable, View } from "components/styledComponents";
import React from "react";
import type { AnimatedStyle } from "react-native-reanimated";
import { useTranslation } from "sharedHooks";

interface Props {
  onPress?: ( ) => void;
  photoUri?: string;
  rotatableAnimatedStyle: AnimatedStyle;
}

// Thumbnail of the most recent photo taken, in the corner where camera apps
// usually show one. Before any photo is taken it holds the space empty so
// the buttons above it don't jump when the first photo appears.
const LatestPhoto = ( { onPress, photoUri, rotatableAnimatedStyle }: Props ) => {
  const { t } = useTranslation( );

  if ( !photoUri ) {
    return (
      <View
        accessibilityElementsHidden
        aria-hidden
        className="w-[62px] h-[62px]"
      />
    );
  }

  return (
    <RotatableIconWrapper
      rotatableAnimatedStyle={rotatableAnimatedStyle}
      containerClass="m-0 border-0"
    >
      <Pressable
        accessibilityLabel={t( "Most-recent-photo" )}
        accessibilityRole="imagebutton"
        disabled={!onPress}
        onPress={onPress}
      >
        <Image
          accessibilityIgnoresInvertColors
          className="w-[62px] h-[62px] rounded border-2 border-white"
          source={{ uri: photoUri }}
          testID="AICamera.latestPhoto"
        />
      </Pressable>
    </RotatableIconWrapper>
  );
};

export default LatestPhoto;
