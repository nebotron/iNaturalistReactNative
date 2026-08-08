import classNames from "classnames";
import { INatIcon } from "components/SharedComponents";
import CachedImage from "components/SharedComponents/CachedImage";
import React from "react";
import type { ViewStyle } from "react-native";

interface Props {
  active?: boolean;
  large?: boolean;
  medium?: boolean;
  small?: boolean;
  // size of the icon; overrides large, medium, and small
  size?: number;
  uri?: string;
}

const UserIcon = ( {
  active,
  large,
  medium,
  size: sizeProp,
  small,
  uri,
}: Props ) => {
  const getSize = ( ) => {
    if ( sizeProp ) return sizeProp;
    if ( small ) {
      return 22;
    }
    if ( large ) {
      return 134;
    }
    if ( medium ) {
      return 62;
    }
    return 40;
  };

  const size = getSize( );

  // For unknown reasons, the green border doesn't show up on Android using nativewind classNames
  // but it works with style, might warrant further investigation or an issue in nativewind
  const style: ViewStyle = {
    width: size,
    height: size,
  };

  return (
    uri
      ? (
        <CachedImage
          accessibilityRole="image"
          testID="UserIcon.photo"
          style={style}
          source={{ uri }}
          className={classNames( "rounded-full", active && "border-[3px] border-inatGreen" )}
        />
      )
      : (
        <INatIcon
          name="person"
          size={size}
        />
      )

  );
};

export default UserIcon;
