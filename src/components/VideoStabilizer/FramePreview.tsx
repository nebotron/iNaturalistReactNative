import { Image, View } from "components/styledComponents";
import React, { useRef, useState } from "react";
import type { GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native";
import Svg, { Circle, Polygon, Rect } from "react-native-svg";
import type { Point } from "sharedHelpers/videoStabilization";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

// The start frame, with what the user has chosen drawn over it: the subject
// box, the crop window and, for background stabilization, the crop center.
// Dragging draws a new subject box; a tap (in "point" mode) moves the crop.

export type FrameInteraction = "box" | "point";

interface Props {
  uri: string;
  // Display size; the frame is scaled to fill it.
  width: number;
  height: number;
  interaction: FrameInteraction;
  // Normalized [x, y, w, h], top-left origin.
  box: number[] | null;
  // Normalized corners of the crop window.
  crop: Point[] | null;
  cropCenter: Point | null;
  onBoxDrawn: ( box: number[] ) => void;
  onPointPicked: ( point: Point ) => void;
  // Lets the parent stop its ScrollView from taking over a drag.
  onDrawingChange: ( drawing: boolean ) => void;
}

const styles = StyleSheet.create( {
  overlay: { left: 0, position: "absolute", top: 0 },
} );

// Shorter than this (as a fraction of the frame) a drag counts as a tap.
const MIN_BOX = 0.03;

const clamp01 = ( v: number ) => Math.min( 1, Math.max( 0, v ) );

const FramePreview = ( {
  uri,
  width,
  height,
  interaction,
  box,
  crop,
  cropCenter,
  onBoxDrawn,
  onPointPicked,
  onDrawingChange,
}: Props ) => {
  const { t } = useTranslation( );
  const origin = useRef<Point | null>( null );
  const [draft, setDraft] = useState<number[] | null>( null );

  const toNormalized = ( event: GestureResponderEvent ): Point => ( {
    x: clamp01( event.nativeEvent.locationX / width ),
    y: clamp01( event.nativeEvent.locationY / height ),
  } );

  const boxBetween = ( a: Point, b: Point ) => [
    Math.min( a.x, b.x ),
    Math.min( a.y, b.y ),
    Math.abs( a.x - b.x ),
    Math.abs( a.y - b.y ),
  ];

  const onGrant = ( event: GestureResponderEvent ) => {
    origin.current = toNormalized( event );
    onDrawingChange( true );
  };

  const onMove = ( event: GestureResponderEvent ) => {
    if ( interaction !== "box" || !origin.current ) return;
    setDraft( boxBetween( origin.current, toNormalized( event ) ) );
  };

  const onRelease = ( event: GestureResponderEvent ) => {
    onDrawingChange( false );
    const start = origin.current;
    origin.current = null;
    setDraft( null );
    if ( !start ) return;
    const end = toNormalized( event );
    const drawn = boxBetween( start, end );
    if ( interaction === "box" && drawn[2] > MIN_BOX && drawn[3] > MIN_BOX ) {
      onBoxDrawn( drawn );
    } else if ( interaction === "point" ) {
      onPointPicked( end );
    }
  };

  const onTerminate = ( ) => {
    onDrawingChange( false );
    origin.current = null;
    setDraft( null );
  };

  const shownBox = draft ?? box;
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={t( "Video-frame" )}
      accessibilityHint={interaction === "box"
        ? t( "Draws-a-box-around-the-subject" )
        : t( "Moves-the-crop-to-the-tapped-point" )}
      style={{ width, height }}
      className="self-center bg-black"
      onStartShouldSetResponder={( ) => true}
      onMoveShouldSetResponder={( ) => true}
      onResponderTerminationRequest={( ) => false}
      onResponderGrant={onGrant}
      onResponderMove={onMove}
      onResponderRelease={onRelease}
      onResponderTerminate={onTerminate}
    >
      <Image
        source={{ uri }}
        style={{ width, height }}
        resizeMode="stretch"
        pointerEvents="none"
      />
      <Svg
        width={width}
        height={height}
        style={styles.overlay}
        pointerEvents="none"
      >
        {crop && crop.length === 4 && (
          <Polygon
            points={crop.map( p => `${p.x * width},${p.y * height}` ).join( " " )}
            fill="none"
            stroke={colors.white}
            strokeWidth={2}
            strokeDasharray="6 4"
          />
        )}
        {shownBox && (
          <Rect
            x={shownBox[0] * width}
            y={shownBox[1] * height}
            width={shownBox[2] * width}
            height={shownBox[3] * height}
            fill="none"
            stroke={colors.inatGreen}
            strokeWidth={3}
          />
        )}
        {interaction === "point" && cropCenter && (
          <Circle
            cx={cropCenter.x * width}
            cy={cropCenter.y * height}
            r={8}
            fill="none"
            stroke={colors.inatGreen}
            strokeWidth={3}
          />
        )}
      </Svg>
    </View>
  );
};

export default FramePreview;
