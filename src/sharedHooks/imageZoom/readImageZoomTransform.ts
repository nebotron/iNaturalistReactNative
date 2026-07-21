import type { SharedValue } from "react-native-reanimated";
import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";

export interface ImageZoomTransformRefs {
  scale: SharedValue<number>;
  translate: {
    x: SharedValue<number>;
    y: SharedValue<number>;
  };
  focal: {
    x: SharedValue<number>;
    y: SharedValue<number>;
  };
}

const readSharedNumber = ( shared: SharedValue<number> ): number => (
  typeof shared.get === "function"
    ? shared.get( )
    : shared.value
);

const readImageZoomTransform = (
  refs: ImageZoomTransformRefs,
): ImageZoomTransform => ( {
  scale: readSharedNumber( refs.scale ),
  translateX: readSharedNumber( refs.translate.x ),
  translateY: readSharedNumber( refs.translate.y ),
  focalX: readSharedNumber( refs.focal.x ),
  focalY: readSharedNumber( refs.focal.y ),
} );

export default readImageZoomTransform;
