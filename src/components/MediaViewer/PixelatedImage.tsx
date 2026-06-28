import Animated from "react-native-reanimated";
import { requireNativeComponent } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

interface NativeProps {
  uri: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  onLayout?: ( event: unknown ) => void;
}

const NativePixelatedImage = requireNativeComponent<NativeProps>( "PixelatedImageView" );

export const AnimatedPixelatedImage = Animated.createAnimatedComponent( NativePixelatedImage );
