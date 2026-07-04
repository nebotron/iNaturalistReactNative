import { useCallback, useRef } from "react";
import type { ComposedGesture, GestureType } from "react-native-gesture-handler";
import { Gesture } from "react-native-gesture-handler";
import type { WithTimingConfig } from "react-native-reanimated";
import {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withTiming,
} from "react-native-reanimated";

import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import type { CropPanContext } from "sharedHelpers/cropPanTranslateLimits";
import { computeCropPanTranslateLimits } from "sharedHelpers/cropPanTranslateLimits";

import type {
  OnPanEndCallback,
  OnPanStartCallback,
  OnPinchEndCallback,
  OnPinchStartCallback,
  ProgrammaticZoomCallback,
  ZoomableUseGesturesProps,
} from "./types";
import { ANIMATION_VALUE, ZOOM_TYPE } from "./types";
import { useAnimationEnd } from "./useAnimationEnd";
import { useInteractionId } from "./useInteractionId";
import { usePanGestureCount } from "./usePanGestureCount";
import { clamp } from "./utils/clamp";
import { limits } from "./utils/limits";
import { sum } from "./utils/sum";

const withTimingConfig: WithTimingConfig = {
  easing: Easing.inOut( Easing.quad ),
};

export const useGestures = ( {
  width,
  height,
  center,
  minScale = 1,
  maxScale = 100,
  scale: scaleValue,
  doubleTapScale = 3,
  isPanEnabled = true,
  isSingleFingerPanEnabled = true,
  isPinchEnabled = true,
  isSingleTapEnabled = false,
  isDoubleTapEnabled = false,
  onInteractionStart,
  onInteractionEnd,
  onPinchStart,
  onPinchEnd,
  onPanStart,
  onPanEnd,
  onSingleTap = () => {},
  onDoubleTap = () => {},
  onProgrammaticZoom = () => {},
  onResetAnimationEnd,
  cropPanContext,
  onSwipeToClose,
}: ZoomableUseGesturesProps ) => {
  const isInteracting = useRef( false );
  const isPinching = useRef( false );
  const { isPanning, startPan, endPan } = usePanGestureCount();

  const savedScale = useSharedValue( 1 );
  const internalScaleValue = useSharedValue( 1 );
  const scale = scaleValue ?? internalScaleValue;
  const initialFocal = { x: useSharedValue( 0 ), y: useSharedValue( 0 ) };
  const pinchPointers = useSharedValue( 0 );
  const pinchBaseEventScale = useSharedValue( 1 );
  const savedFocal = { x: useSharedValue( 0 ), y: useSharedValue( 0 ) };
  const focal = { x: useSharedValue( 0 ), y: useSharedValue( 0 ) };
  const savedTranslate = { x: useSharedValue( 0 ), y: useSharedValue( 0 ) };
  const translate = { x: useSharedValue( 0 ), y: useSharedValue( 0 ) };

  const { getInteractionId, updateInteractionId } = useInteractionId();
  const { onAnimationEnd } = useAnimationEnd( onResetAnimationEnd );

  const reset = useCallback( () => {
    "worklet";

    const interactionId = getInteractionId();

    savedScale.value = 1;
    const lastScaleValue = scale.value;
    scale.value = withTiming( 1, withTimingConfig, ( ...args ) => onAnimationEnd(
      interactionId,
      ANIMATION_VALUE.SCALE,
      lastScaleValue,
      ...args,
    ) );
    initialFocal.x.value = 0;
    initialFocal.y.value = 0;
    savedFocal.x.value = 0;
    savedFocal.y.value = 0;
    const lastFocalXValue = focal.x.value;
    focal.x.value = withTiming( 0, withTimingConfig, ( ...args ) => onAnimationEnd(
      interactionId,
      ANIMATION_VALUE.FOCAL_X,
      lastFocalXValue,
      ...args,
    ) );
    const lastFocalYValue = focal.y.value;
    focal.y.value = withTiming( 0, withTimingConfig, ( ...args ) => onAnimationEnd(
      interactionId,
      ANIMATION_VALUE.FOCAL_Y,
      lastFocalYValue,
      ...args,
    ) );
    savedTranslate.x.value = 0;
    savedTranslate.y.value = 0;
    const lastTranslateXValue = translate.x.value;
    translate.x.value = withTiming( 0, withTimingConfig, ( ...args ) => onAnimationEnd(
      interactionId,
      ANIMATION_VALUE.TRANSLATE_X,
      lastTranslateXValue,
      ...args,
    ) );
    const lastTranslateYValue = translate.y.value;
    translate.y.value = withTiming( 0, withTimingConfig, ( ...args ) => onAnimationEnd(
      interactionId,
      ANIMATION_VALUE.TRANSLATE_Y,
      lastTranslateYValue,
      ...args,
    ) );
  }, [
    savedScale,
    scale,
    initialFocal.x,
    initialFocal.y,
    savedFocal.x,
    savedFocal.y,
    focal.x,
    focal.y,
    savedTranslate.x,
    savedTranslate.y,
    translate.x,
    translate.y,
    getInteractionId,
    onAnimationEnd,
  ] );

  const moveIntoView = () => {
    "worklet";

    if ( cropPanContext ) {
      const panLimits = computeCropPanTranslateLimits( cropPanContext, {
        scale: scale.value,
        translateX: translate.x.value,
        translateY: translate.y.value,
        focalX: focal.x.value,
        focalY: focal.y.value,
      } );
      const totalTranslateX = sum( translate.x, focal.x );
      const totalTranslateY = sum( translate.y, focal.y );

      if ( totalTranslateX < panLimits.minTotalTranslateX ) {
        translate.x.value = withTiming(
          panLimits.minTotalTranslateX - focal.x.value,
          withTimingConfig,
        );
      } else if ( totalTranslateX > panLimits.maxTotalTranslateX ) {
        translate.x.value = withTiming(
          panLimits.maxTotalTranslateX - focal.x.value,
          withTimingConfig,
        );
      }

      if ( totalTranslateY < panLimits.minTotalTranslateY ) {
        translate.y.value = withTiming(
          panLimits.minTotalTranslateY - focal.y.value,
          withTimingConfig,
        );
      } else if ( totalTranslateY > panLimits.maxTotalTranslateY ) {
        translate.y.value = withTiming(
          panLimits.maxTotalTranslateY - focal.y.value,
          withTimingConfig,
        );
      }

      return;
    }

    if ( scale.value > 1 ) {
      const rightLimit = limits.right( width, scale );
      const leftLimit = -rightLimit;
      const bottomLimit = limits.bottom( height, scale );
      const topLimit = -bottomLimit;
      const totalTranslateX = sum( translate.x, focal.x );
      const totalTranslateY = sum( translate.y, focal.y );

      if ( totalTranslateX > rightLimit ) {
        translate.x.value = withTiming( rightLimit, withTimingConfig );
        focal.x.value = withTiming( 0, withTimingConfig );
      } else if ( totalTranslateX < leftLimit ) {
        translate.x.value = withTiming( leftLimit, withTimingConfig );
        focal.x.value = withTiming( 0, withTimingConfig );
      }

      if ( totalTranslateY > bottomLimit ) {
        translate.y.value = withTiming( bottomLimit, withTimingConfig );
        focal.y.value = withTiming( 0, withTimingConfig );
      } else if ( totalTranslateY < topLimit ) {
        translate.y.value = withTiming( topLimit, withTimingConfig );
        focal.y.value = withTiming( 0, withTimingConfig );
      }
    } else {
      reset();
    }
  };

  const applyTransform = useCallback( ( transform: ImageZoomTransform ) => {
    "worklet";

    savedScale.value = transform.scale;
    scale.value = transform.scale;
    savedFocal.x.value = transform.focalX;
    savedFocal.y.value = transform.focalY;
    focal.x.value = transform.focalX;
    focal.y.value = transform.focalY;
    savedTranslate.x.value = transform.translateX;
    savedTranslate.y.value = transform.translateY;
    translate.x.value = transform.translateX;
    translate.y.value = transform.translateY;
  }, [
    focal.x,
    focal.y,
    savedFocal.x,
    savedFocal.y,
    savedScale,
    savedTranslate.x,
    savedTranslate.y,
    scale,
    translate.x,
    translate.y,
  ] );

  const zoom: ProgrammaticZoomCallback = event => {
    "worklet";

    if ( event.scale > 1 ) {
      runOnJS( onProgrammaticZoom )( ZOOM_TYPE.ZOOM_IN );
      scale.value = withTiming( event.scale, withTimingConfig );
      focal.x.value = withTiming(
        ( center.x - event.x ) * ( event.scale - 1 ),
        withTimingConfig,
      );
      focal.y.value = withTiming(
        ( center.y - event.y ) * ( event.scale - 1 ),
        withTimingConfig,
      );
    } else {
      runOnJS( onProgrammaticZoom )( ZOOM_TYPE.ZOOM_OUT );
      reset();
    }
  };

  const onInteractionStarted = () => {
    if ( !isInteracting.current ) {
      isInteracting.current = true;
      onInteractionStart?.();
      updateInteractionId();
    }
  };

  const onInteractionEnded = () => {
    if ( isInteracting.current && !isPinching.current && !isPanning() ) {
      // When a cropPanContext is present (e.g. the Explore grid) the gesture
      // reframes a persisted crop, so leave the image exactly where the user
      // placed it: no settling, nudging, or reset on release.
      if ( !cropPanContext ) {
        if ( isDoubleTapEnabled ) {
          moveIntoView();
        } else {
          reset();
        }
      }
      isInteracting.current = false;
      onInteractionEnd?.();
    }
  };

  const onPinchStarted: OnPinchStartCallback = event => {
    onInteractionStarted();
    isPinching.current = true;
    onPinchStart?.( event );
  };

  const onPinchEnded: OnPinchEndCallback = ( ...args ) => {
    isPinching.current = false;
    onPinchEnd?.( ...args );
    onInteractionEnded();
  };

  const onPanStarted: OnPanStartCallback = event => {
    onInteractionStarted();
    startPan();
    onPanStart?.( event );
  };

  const onPanEnded: OnPanEndCallback = ( ...args ) => {
    endPan();
    onPanEnd?.( ...args );
    onInteractionEnded();
  };

  const getPanClampLimits = () => {
    "worklet";

    if ( cropPanContext ) {
      const panLimits = computeCropPanTranslateLimits( cropPanContext, {
        scale: scale.value,
        translateX: translate.x.value,
        translateY: translate.y.value,
        focalX: focal.x.value,
        focalY: focal.y.value,
      } );

      return {
        leftLimit: panLimits.minTotalTranslateX - focal.x.value,
        rightLimit: panLimits.maxTotalTranslateX - focal.x.value,
        topLimit: panLimits.minTotalTranslateY - focal.y.value,
        bottomLimit: panLimits.maxTotalTranslateY - focal.y.value,
      };
    }

    const rightLimit = limits.right( width, scale );
    return {
      leftLimit: -rightLimit,
      rightLimit,
      topLimit: -limits.bottom( height, scale ),
      bottomLimit: limits.bottom( height, scale ),
    };
  };

  const panOnlyGesture = Gesture.Pan()
    .enabled( isPanEnabled )
    .averageTouches( true )
    .enableTrackpadTwoFingerGesture( true )
    .minPointers( 1 )
    .maxPointers( 1 )
    .onTouchesDown( ( _, manager ) => {
      if ( !cropPanContext && scale.value <= 1 ) {
        manager.fail();
      }
    } )
    .onStart( event => {
      runOnJS( onPanStarted )( event );
      savedTranslate.x.value = translate.x.value;
      savedTranslate.y.value = translate.y.value;
    } )
    .onUpdate( event => {
      const desiredX = savedTranslate.x.value + event.translationX;
      const desiredY = savedTranslate.y.value + event.translationY;
      if ( cropPanContext ) {
        const panLimits = computeCropPanTranslateLimits( cropPanContext, {
          scale: scale.value,
          translateX: desiredX,
          translateY: desiredY,
          focalX: focal.x.value,
          focalY: focal.y.value,
        } );
        translate.x.value = clamp(
          desiredX + focal.x.value,
          panLimits.minTotalTranslateX,
          panLimits.maxTotalTranslateX,
        ) - focal.x.value;
        translate.y.value = clamp(
          desiredY + focal.y.value,
          panLimits.minTotalTranslateY,
          panLimits.maxTotalTranslateY,
        ) - focal.y.value;
      } else {
        translate.x.value = desiredX;
        translate.y.value = desiredY;
      }
    } )
    .onEnd( ( event, success ) => {
      const {
        leftLimit,
        rightLimit,
        topLimit,
        bottomLimit,
      } = getPanClampLimits( );

      if ( !cropPanContext && scale.value > 1 && isDoubleTapEnabled ) {
        translate.x.value = withDecay(
          {
            velocity: event.velocityX,
            velocityFactor: 0.6,
            rubberBandEffect: true,
            rubberBandFactor: 0.9,
            clamp: [leftLimit, rightLimit],
          },
          () => {
            if ( event.velocityX >= event.velocityY ) {
              runOnJS( onPanEnded )( event, success );
            }
          },
        );
        translate.y.value = withDecay(
          {
            velocity: event.velocityY,
            velocityFactor: 0.6,
            rubberBandEffect: true,
            rubberBandFactor: 0.9,
            clamp: [topLimit, bottomLimit],
          },
          () => {
            if ( event.velocityY > event.velocityX ) {
              runOnJS( onPanEnded )( event, success );
            }
          },
        );
      } else {
        runOnJS( onPanEnded )( event, success );
      }
    } );

  // A single pinch gesture handles both zooming and two-finger panning by
  // tracking the live centroid of the two fingers every frame. The image point
  // under the centroid when the pinch began stays pinned under the centroid as
  // the fingers move and spread, so zooming follows the fingers and a
  // two-finger drag pans. Folding pan into the pinch (rather than running a
  // separate averageTouches pan gesture alongside it) avoids the double-counted
  // translation that previously caused jitter, and it is exact at any scale so
  // the point under the fingers does not drift even at high maxScale.
  const pinchGesture = Gesture.Pinch()
    .enabled( isPinchEnabled )
    .onStart( event => {
      runOnJS( onPinchStarted )( event );
      savedScale.value = scale.value;
      savedFocal.x.value = focal.x.value;
      savedFocal.y.value = focal.y.value;
      savedTranslate.x.value = translate.x.value;
      savedTranslate.y.value = translate.y.value;
      initialFocal.x.value = event.focalX;
      initialFocal.y.value = event.focalY;
      pinchPointers.value = event.numberOfPointers;
      pinchBaseEventScale.value = 1;
    } )
    .onUpdate( event => {
      if ( event.numberOfPointers !== pinchPointers.value ) {
        // When a finger is added or lifted the reported centroid jumps to the
        // centroid of the new finger set, so re-anchor the pinch at the
        // current transform instead of letting the pin-to-centroid math yank
        // the image (most visible on release, when fingers rarely lift in the
        // same frame).
        pinchPointers.value = event.numberOfPointers;
        pinchBaseEventScale.value = event.scale;
        savedScale.value = scale.value;
        savedFocal.x.value = focal.x.value;
        savedFocal.y.value = focal.y.value;
        savedTranslate.x.value = translate.x.value;
        savedTranslate.y.value = translate.y.value;
        initialFocal.x.value = event.focalX;
        initialFocal.y.value = event.focalY;
      }
      const newScale = clamp(
        savedScale.value * ( event.scale / pinchBaseEventScale.value ),
        minScale,
        maxScale,
      );
      const ratio = newScale / savedScale.value;
      scale.value = newScale;

      // Total offset ( translate + focal ) at the start of the pinch.
      const total0X = savedTranslate.x.value + savedFocal.x.value;
      const total0Y = savedTranslate.y.value + savedFocal.y.value;
      // Start and current centroid positions, relative to the view center.
      const startFocalX = initialFocal.x.value - center.x;
      const startFocalY = initialFocal.y.value - center.y;
      const currentFocalX = event.focalX - center.x;
      const currentFocalY = event.focalY - center.y;

      // Keep the image point under the start centroid pinned to the current
      // centroid, so both zoom and two-finger pan follow the fingers.
      const totalNewX = currentFocalX - ratio * ( startFocalX - total0X );
      const totalNewY = currentFocalY - ratio * ( startFocalY - total0Y );

      if ( cropPanContext ) {
        const panLimits = computeCropPanTranslateLimits( cropPanContext, {
          scale: newScale,
          translateX: savedTranslate.x.value,
          translateY: savedTranslate.y.value,
          focalX: focal.x.value,
          focalY: focal.y.value,
        } );
        focal.x.value = clamp(
          totalNewX,
          panLimits.minTotalTranslateX,
          panLimits.maxTotalTranslateX,
        ) - savedTranslate.x.value;
        focal.y.value = clamp(
          totalNewY,
          panLimits.minTotalTranslateY,
          panLimits.maxTotalTranslateY,
        ) - savedTranslate.y.value;
      } else {
        focal.x.value = totalNewX - savedTranslate.x.value;
        focal.y.value = totalNewY - savedTranslate.y.value;
      }
    } )
    .onEnd( ( ...args ) => {
      runOnJS( onPinchEnded )( ...args );
    } );

  const doubleTapGesture = Gesture.Tap()
    .enabled( isDoubleTapEnabled )
    .numberOfTaps( 2 )
    .maxDuration( 250 )
    .onStart( event => {
      if ( scale.value === 1 ) {
        runOnJS( onDoubleTap )( ZOOM_TYPE.ZOOM_IN );
        scale.value = withTiming( doubleTapScale, withTimingConfig );
        focal.x.value = withTiming(
          ( center.x - event.x ) * ( doubleTapScale - 1 ),
          withTimingConfig,
        );
        focal.y.value = withTiming(
          ( center.y - event.y ) * ( doubleTapScale - 1 ),
          withTimingConfig,
        );
      } else {
        runOnJS( onDoubleTap )( ZOOM_TYPE.ZOOM_OUT );
        reset();
      }
    } );

  const singleTapGesture = Gesture.Tap()
    .enabled( isSingleTapEnabled )
    .numberOfTaps( 1 )
    .maxDistance( 24 )
    .onStart( event => {
      runOnJS( onSingleTap )( event );
    } );

  const animatedStyle = useAnimatedStyle( () => ( {
    transform: [
      { translateX: translate.x.value },
      { translateY: translate.y.value },
      { translateX: focal.x.value },
      { translateY: focal.y.value },
      { scale: scale.value },
    ],
  } ) );

  // The pinch gesture handles two-finger zoom and pan together (see above), so
  // every surface (crop editor, MediaViewer, IDing game) shares the same gesture
  // and behaves identically. A separate one-finger panOnlyGesture handles panning
  // once zoomed in.
  const pinchPanGestures = pinchGesture;

  // When onSwipeToClose is provided, add a downward-swipe gesture into the same
  // GestureDetector as the zoom gestures. This avoids the cross-detector coordination
  // overhead that causes lag when swipe-to-close lives in a separate outer GestureDetector.
  // It runs on the UI thread (no runOnJS) and fails immediately when zoomed in so that
  // the panOnlyGesture can handle panning instead.
  const swipeToCloseGesture = onSwipeToClose
    ? Gesture.Pan()
      .maxPointers( 1 )
      .activeOffsetY( 15 )
      .failOffsetX( [-15, 15] )
      .onTouchesDown( ( _, manager ) => {
        "worklet";
        if ( scale.value > 1 ) {
          manager.fail();
        }
      } )
      .onUpdate( ( { translationY, velocityY } ) => {
        "worklet";
        if ( translationY > 50 && velocityY > 500 ) {
          runOnJS( onSwipeToClose )();
        }
      } )
    : null;

  const tapGestures = Gesture.Exclusive( doubleTapGesture, singleTapGesture );

  // Build a flat list of competing gestures so there is only one Race layer. The
  // two-finger pinch always competes; the one-finger panOnlyGesture is included
  // only when single-finger panning is enabled (disabled on the Explore grid so
  // one finger scrolls the list and two fingers are required to pan or zoom).
  // swipeToCloseGesture (when present) fails immediately for 2-finger touches
  // (maxPointers=1) and when zoomed (scale > 1), so it never interferes.
  const competingGestures: ( ComposedGesture | GestureType )[] = [pinchPanGestures];
  if ( isSingleFingerPanEnabled ) {
    competingGestures.push( panOnlyGesture );
  }
  if ( isDoubleTapEnabled || isSingleTapEnabled ) {
    competingGestures.push( tapGestures );
  }
  if ( swipeToCloseGesture ) {
    competingGestures.push( swipeToCloseGesture );
  }
  const gestures = competingGestures.length > 1
    ? Gesture.Race( ...competingGestures )
    : competingGestures[0];

  return {
    gestures,
    animatedStyle,
    zoom,
    reset,
    applyTransform,
    transform: {
      scale,
      translate,
      focal,
    },
  };
};
