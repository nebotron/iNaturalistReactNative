import { View } from "components/styledComponents";
import React, { useState } from "react";
import type { GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native";
import Svg, { Rect } from "react-native-svg";
import type { Point } from "sharedHelpers/videoStabilization";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

// A transparent layer over the stabilized preview. Dragging draws a rectangle
// with the video's aspect ratio from where the finger went down; letting go
// reports it, normalized to the preview, as the window to zoom to.

export interface ZoomWindow {
  center: Point;
  // Fraction of the preview's width (and, with the aspect kept, height).
  size: number;
}

interface Props {
  width: number;
  height: number;
  disabled?: boolean;
  onWindowPicked: ( window: ZoomWindow ) => void;
}

// A shorter drag is taken as a stray touch rather than a rectangle.
const MIN_SIDE_PX = 12;

const styles = StyleSheet.create( {
  overlay: { left: 0, position: "absolute", top: 0 },
} );

const clamp = ( v: number, max: number ) => Math.min( max, Math.max( 0, v ) );

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ZoomRectangle = ( {
  width,
  height,
  disabled,
  onWindowPicked,
}: Props ) => {
  const { t } = useTranslation( );
  const [anchor, setAnchor] = useState<Point | null>( null );
  const [box, setBox] = useState<Box | null>( null );
  const aspect = width / height;

  const pointOf = ( event: GestureResponderEvent ): Point => ( {
    x: clamp( event.nativeEvent.locationX, width ),
    y: clamp( event.nativeEvent.locationY, height ),
  } );

  // The rectangle from the anchor toward the finger, as large as the drag in
  // either direction allows, kept to the video's aspect and inside the view.
  const boxTo = ( from: Point, to: Point ): Box => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const room = Math.min(
      dx < 0
        ? from.x
        : width - from.x,
      ( dy < 0
        ? from.y
        : height - from.y ) * aspect,
    );
    const boxWidth = Math.min( Math.max( Math.abs( dx ), Math.abs( dy ) * aspect ), room );
    const boxHeight = boxWidth / aspect;
    return {
      x: dx < 0
        ? from.x - boxWidth
        : from.x,
      y: dy < 0
        ? from.y - boxHeight
        : from.y,
      width: boxWidth,
      height: boxHeight,
    };
  };

  const finish = ( ) => {
    if ( box && box.width >= MIN_SIDE_PX ) {
      onWindowPicked( {
        center: {
          x: ( box.x + box.width / 2 ) / width,
          y: ( box.y + box.height / 2 ) / height,
        },
        size: box.width / width,
      } );
    }
    setAnchor( null );
    setBox( null );
  };

  return (
    <View
      accessible
      accessibilityLabel={t( "Stabilized--video-stabilizer" )}
      accessibilityHint={t( "Zooms-to-the-rectangle-dragged-over-the-video" )}
      style={[styles.overlay, { width, height }]}
      onStartShouldSetResponder={( ) => !disabled}
      onMoveShouldSetResponder={( ) => !disabled}
      onResponderTerminationRequest={( ) => false}
      onResponderGrant={event => {
        const point = pointOf( event );
        setAnchor( point );
        setBox( null );
      }}
      onResponderMove={event => {
        if ( anchor ) setBox( boxTo( anchor, pointOf( event ) ) );
      }}
      onResponderRelease={finish}
      onResponderTerminate={( ) => {
        setAnchor( null );
        setBox( null );
      }}
    >
      {box && (
        <Svg width={width} height={height} pointerEvents="none">
          <Rect
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill="none"
            stroke={colors.white}
            strokeWidth={2}
            strokeDasharray="6 4"
          />
        </Svg>
      )}
    </View>
  );
};

export default ZoomRectangle;
