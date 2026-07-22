import { getCurrentRoute } from "navigation/navigationUtils";
import React from "react";
import type { GestureResponderEvent, PressableProps, View } from "react-native";
import { Pressable } from "react-native";
import { logWithoutRemote } from "sharedHelpers/logger";

// Local-only breadcrumb: useful when reading a device log, not worth a remote
// POST per tap (this was the single largest source of remote log volume).
const logger = logWithoutRemote.extend( "PressableWithTracking" );

interface Props extends PressableProps {
  ref?: React.Ref<View>;
}

const PressableWithTracking = ( props: Props ) => {
  const { onPress, ref, ...otherProps } = props;

  const handlePressWithTracking = ( event: GestureResponderEvent ) => {
    if ( otherProps?.testID ) {
      const currentRoute = getCurrentRoute( );
      logger.info( `Button tap: ${otherProps?.testID}-${currentRoute?.name || "undefined"}` );
    }

    if ( onPress ) {
      onPress( event );
    }
  };

  // eslint-disable-next-line react/jsx-props-no-spreading
  return <Pressable {...otherProps} onPress={handlePressWithTracking} ref={ref} />;
};

export default PressableWithTracking;
