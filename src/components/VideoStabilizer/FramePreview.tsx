import { Image, View } from "components/styledComponents";
import React from "react";
import type { GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native";
import Svg, { Circle, Polygon } from "react-native-svg";
import type { Point } from "sharedHelpers/videoStabilization";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

// The start frame, with the crop window and its center drawn over it. A tap
// moves the crop there; a drag scrolls the page as usual.

interface Props {
  uri: string;
  // Display size; the frame is scaled to fill it.
  width: number;
  height: number;
  // Normalized corners of the crop window.
  crop: Point[] | null;
  cropCenter: Point | null;
  onPointPicked: ( point: Point ) => void;
}

const styles = StyleSheet.create( {
  overlay: { left: 0, position: "absolute", top: 0 },
} );

const clamp01 = ( v: number ) => Math.min( 1, Math.max( 0, v ) );

const FramePreview = ( {
  uri,
  width,
  height,
  crop,
  cropCenter,
  onPointPicked,
}: Props ) => {
  const { t } = useTranslation( );

  const toNormalized = ( event: GestureResponderEvent ): Point => ( {
    x: clamp01( event.nativeEvent.locationX / width ),
    y: clamp01( event.nativeEvent.locationY / height ),
  } );

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={t( "Video-frame" )}
      accessibilityHint={t( "Moves-the-crop-to-the-tapped-point" )}
      style={{ width, height }}
      className="self-center bg-black"
      onStartShouldSetResponder={( ) => true}
      onResponderRelease={event => onPointPicked( toNormalized( event ) )}
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
        {cropCenter && (
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
