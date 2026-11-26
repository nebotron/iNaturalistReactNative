import type { Ref } from "react";
import { useImperativeHandle } from "react";
import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";

import type { ProgrammaticZoomCallback, ZoomableRef } from "./types";

export const useZoomableHandle = (
  ref: Ref<unknown> | undefined,
  reset: () => void,
  zoom: ProgrammaticZoomCallback,
  applyTransform: ( transform: ImageZoomTransform ) => void,
) => {
  useImperativeHandle(
    ref,
    (): ZoomableRef => ( {
      reset() {
        reset();
      },
      zoom( event ) {
        zoom( event );
      },
      applyTransform( transform ) {
        applyTransform( transform );
      },
    } ),
    [applyTransform, reset, zoom],
  );
};
