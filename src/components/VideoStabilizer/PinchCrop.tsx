import { View } from "components/styledComponents";
import React, { useRef, useState } from "react";
import type { GestureResponderEvent, NativeTouchEvent } from "react-native";
import { StyleSheet } from "react-native";
import Svg, { Rect } from "react-native-svg";
import type { Point } from "sharedHelpers/videoStabilization";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

// A transparent layer over the stabilized preview. Two fingers mark two
// opposite corners of the crop: the window is centered between them and
// sized to span them, keeping the frame's aspect, so it covers the larger of
// the two spans. A dashed outline shows the window that will fill the
// frame, and letting go reports it, normalized to the preview, as the window
// to zoom to.
//
// One finger is left alone so it scrolls the page: the layer reads raw
// touches instead of taking the responder, and asks the page to stop
// scrolling only once a second finger is down.

export interface ZoomWindow {
  center: Point;
  // Fraction of the preview's width (and, with the aspect kept, height).
  // Above 1 zooms out.
  size: number;
}

interface Props {
  width: number;
  height: number;
  disabled?: boolean;
  // The range of window sizes the crop can take from the preview's zoom.
  minSize: number;
  maxSize: number;
  // Told when a two-finger drag starts and ends, so a scroll view around the
  // preview can stop scrolling meanwhile.
  onPinchingChange?: ( pinching: boolean ) => void;
  onWindowPicked: ( window: ZoomWindow ) => void;
}

// Fingers that barely move are taken as a stray touch.
const MIN_MOVE_PX = 6;

const styles = StyleSheet.create( {
  overlay: {
    left: 0, overflow: "hidden", position: "absolute", top: 0,
  },
} );

interface Drag {
  // Page coordinates minus the overlay's own.
  offset: Point;
  start: [Point, Point];
}

const cornersOf = ( [a, b]: NativeTouchEvent[] ): [Point, Point] => [
  { x: a.pageX, y: a.pageY },
  { x: b.pageX, y: b.pageY },
];

const PinchCrop = ( {
  width,
  height,
  disabled,
  minSize,
  maxSize,
  onPinchingChange,
  onWindowPicked,
}: Props ) => {
  const { t } = useTranslation( );
  const drag = useRef<Drag | null>( null );
  const [picked, setPicked] = useState<ZoomWindow | null>( null );
  const latest = useRef<ZoomWindow | null>( null );
  const moved = useRef( false );

  const end = ( report: boolean ) => {
    if ( !drag.current ) return;
    drag.current = null;
    setPicked( null );
    onPinchingChange?.( false );
    if ( report && moved.current && latest.current ) onWindowPicked( latest.current );
  };

  // The fingers are two opposite corners, in either order: the window is
  // centered between them, and as wide as their horizontal span or as tall
  // as their vertical one, whichever needs the larger window.
  const update = ( touches: NativeTouchEvent[] ) => {
    const { current } = drag;
    if ( !current ) return;
    const corners = cornersOf( touches );
    if ( corners.some( ( corner, i ) => Math.hypot(
      corner.x - current.start[i].x,
      corner.y - current.start[i].y,
    ) > MIN_MOVE_PX ) ) {
      moved.current = true;
    }
    const [a, b] = corners.map( corner => ( {
      x: corner.x - current.offset.x,
      y: corner.y - current.offset.y,
    } ) );
    const span = Math.max( Math.abs( a.x - b.x ) / width, Math.abs( a.y - b.y ) / height );
    const window = {
      center: { x: ( a.x + b.x ) / 2 / width, y: ( a.y + b.y ) / 2 / height },
      size: Math.min( maxSize, Math.max( minSize, span ) ),
    };
    latest.current = window;
    if ( moved.current ) setPicked( window );
  };

  const begin = ( touches: NativeTouchEvent[] ) => {
    const [first] = touches;
    drag.current = {
      offset: { x: first.pageX - first.locationX, y: first.pageY - first.locationY },
      start: cornersOf( touches ),
    };
    latest.current = null;
    moved.current = false;
    onPinchingChange?.( true );
    update( touches );
  };

  const onTouches = ( event: GestureResponderEvent ) => {
    if ( disabled ) {
      end( false );
      return;
    }
    const { touches } = event.nativeEvent;
    if ( touches.length >= 2 ) {
      if ( !drag.current ) begin( touches );
      else update( touches );
    } else {
      end( true );
    }
  };

  const box = picked && {
    width: picked.size * width,
    height: picked.size * height,
    x: ( picked.center.x - picked.size / 2 ) * width,
    y: ( picked.center.y - picked.size / 2 ) * height,
  };

  return (
    <View
      accessible
      accessibilityLabel={t( "Stabilized--video-stabilizer" )}
      accessibilityHint={t( "Drag-two-fingers-to-set-opposite-corners-of-the-crop" )}
      style={[styles.overlay, { width, height }]}
      onTouchStart={onTouches}
      onTouchMove={onTouches}
      onTouchEnd={onTouches}
      onTouchCancel={( ) => end( false )}
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

export default PinchCrop;
