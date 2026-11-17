import { View } from "components/styledComponents";
import React, { useRef, useState } from "react";
import type { GestureResponderEvent, NativeTouchEvent } from "react-native";
import { StyleSheet } from "react-native";
import Svg, { Rect } from "react-native-svg";
import type { Point } from "sharedHelpers/videoStabilization";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

// A transparent layer over the stabilized preview. Two fingers zoom and move
// the crop, the way they would zoom and move a photo: spreading them zooms
// in on the point between them and dragging them moves what's in view. A
// dashed outline shows the window that will fill the frame, and letting go
// reports it, normalized to the preview, as the window to zoom to.
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
  // Told when a pinch starts and ends, so a scroll view around the preview
  // can stop scrolling meanwhile.
  onPinchingChange?: ( pinching: boolean ) => void;
  onWindowPicked: ( window: ZoomWindow ) => void;
}

// A pinch that barely changes anything is taken as a stray touch.
const MIN_SCALE_CHANGE = 0.03;
const MIN_PAN_PX = 6;

const styles = StyleSheet.create( {
  overlay: {
    left: 0, overflow: "hidden", position: "absolute", top: 0,
  },
} );

interface Pinch {
  // Page coordinates minus the overlay's own.
  offset: Point;
  startFocal: Point;
  startDistance: number;
}

const focalOf = ( [a, b]: NativeTouchEvent[] ): Point => ( {
  x: ( a.pageX + b.pageX ) / 2,
  y: ( a.pageY + b.pageY ) / 2,
} );
const distanceOf = ( [a, b]: NativeTouchEvent[] ) => Math.max(
  1,
  Math.hypot( a.pageX - b.pageX, a.pageY - b.pageY ),
);

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
  const pinch = useRef<Pinch | null>( null );
  const [picked, setPicked] = useState<ZoomWindow | null>( null );
  const latest = useRef<ZoomWindow | null>( null );
  const moved = useRef( false );

  const begin = ( touches: NativeTouchEvent[] ) => {
    const [first] = touches;
    pinch.current = {
      offset: { x: first.pageX - first.locationX, y: first.pageY - first.locationY },
      startFocal: focalOf( touches ),
      startDistance: distanceOf( touches ),
    };
    latest.current = null;
    moved.current = false;
    onPinchingChange?.( true );
  };

  const end = ( report: boolean ) => {
    if ( !pinch.current ) return;
    pinch.current = null;
    setPicked( null );
    onPinchingChange?.( false );
    if ( report && moved.current && latest.current ) onWindowPicked( latest.current );
  };

  // The content point under the starting focal point stays under the
  // fingers, scaled by how far they've spread: screen x shows content
  // startFocal + ( x - focal ) / scale, so the window around the screen's
  // middle is centered there.
  const update = ( touches: NativeTouchEvent[] ) => {
    const { current } = pinch;
    if ( !current ) return;
    const rawScale = distanceOf( touches ) / current.startDistance;
    const size = Math.min( maxSize, Math.max( minSize, 1 / rawScale ) );
    const focal = focalOf( touches );
    const start = {
      x: current.startFocal.x - current.offset.x,
      y: current.startFocal.y - current.offset.y,
    };
    const now = { x: focal.x - current.offset.x, y: focal.y - current.offset.y };
    if (
      Math.abs( rawScale - 1 ) > MIN_SCALE_CHANGE
      || Math.hypot( now.x - start.x, now.y - start.y ) > MIN_PAN_PX
    ) {
      moved.current = true;
    }
    const window = {
      center: {
        x: ( start.x + ( width / 2 - now.x ) * size ) / width,
        y: ( start.y + ( height / 2 - now.y ) * size ) / height,
      },
      size,
    };
    latest.current = window;
    if ( moved.current ) setPicked( window );
  };

  const onTouches = ( event: GestureResponderEvent ) => {
    if ( disabled ) {
      end( false );
      return;
    }
    const { touches } = event.nativeEvent;
    if ( touches.length >= 2 ) {
      if ( !pinch.current ) begin( touches );
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
      accessibilityHint={t( "Pinch-with-two-fingers-to-zoom-and-move-the-crop" )}
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
