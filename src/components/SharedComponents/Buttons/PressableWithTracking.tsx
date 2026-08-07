import React from "react";
import type { GestureResponderEvent, PressableProps, View } from "react-native";
import { Pressable } from "react-native";

interface Props extends PressableProps {
  ref?: React.Ref<View>;
}

const PressableWithTracking = ( props: Props ) => {
  const { onPress, ref, ...otherProps } = props;

  const handlePressWithTracking = ( event: GestureResponderEvent ) => {
    if ( onPress ) {
      onPress( event );
    }
  };

  // eslint-disable-next-line react/jsx-props-no-spreading
  return <Pressable {...otherProps} onPress={handlePressWithTracking} ref={ref} />;
};

export default PressableWithTracking;
