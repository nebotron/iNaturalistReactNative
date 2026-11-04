import { useAppState } from "@react-native-community/hooks";
import { useIsFocused } from "@react-navigation/native";
import {
  Camera,
} from "components/Camera/helpers/visionCameraWrapper";
import useFocusTap from "components/Camera/hooks/useFocusTap";
import type { RefObject } from "react";
import React, {
  useCallback,
  useEffect,
} from "react";
import {
  Platform, StyleSheet,
} from "react-native";
import type {
  PanGesture,
  PinchGesture,
} from "react-native-gesture-handler";
import {
  Gesture,
  GestureDetector,
} from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";
import type {
  CameraDevice,
  CameraFrameOutput,
  CameraPhotoOutput,
  CameraRef,
} from "react-native-vision-camera";
import { log } from "sharedHelpers/logger";

import FocusSquare from "./FocusSquare";

const logger = log.extend( "CameraView" );

interface Props {
  cameraRef: RefObject<CameraRef | null>;
  device: CameraDevice;
  frameOutput?: CameraFrameOutput;
  inactive?: boolean;
  onCameraError: ( error: Error ) => void;
  panToZoom: PanGesture;
  photoOutput: CameraPhotoOutput;
  pinchToZoom: PinchGesture;
  resizeMode?: "cover" | "contain";
  zoom: SharedValue<number>;
  macroMode?: boolean;
}

// A container for the Camera component
// that has logic that applies to both use cases in StandardCamera and AICamera
const CameraView = ( {
  cameraRef,
  device,
  frameOutput,
  inactive,
  onCameraError,
  panToZoom,
  photoOutput,
  pinchToZoom,
  resizeMode,
  zoom,
  macroMode = false,
}: Props ) => {
  const { animatedStyle, tapToFocus, tappedCoordinates }
    = useFocusTap( cameraRef, device.supportsFocusMetering && !macroMode );

  // check if camera page is active
  const isFocused = useIsFocused( );
  const appState = useAppState( );
  const isActive = !inactive && isFocused && appState === "active";

  const onError = useCallback(
    ( error: Error ) => {
      // TODO: on Android there is an error upon every camera start. Apparently out useZoom hook
      // tries to set the zoom value before the camera is active. Re-visit this after vision-camera
      // v5 has some more maturity
      const message = error?.message ?? "";
      if ( message.includes( "Camera is not active" ) ) {
        return;
      }
      console.log( "error", error );
      onCameraError( error );
    },
    [onCameraError],
  );

  // Macro mode locks the lens at its closest focus distance. The controller is
  // recreated whenever the session restarts (e.g. switching to the macro
  // device), so this runs both when macroMode changes and on every start.
  const applyMacroFocus = useCallback( async ( ) => {
    const controller = cameraRef.current?.controller;
    if ( !controller?.device.supportsFocusLocking ) { return; }
    try {
      if ( macroMode ) {
        await controller.setFocusLocked( 0 );
      } else if ( controller.focusMode === "locked" ) {
        await controller.resetFocus( );
      }
    } catch ( error ) {
      logger.error( "Failed to apply macro focus", error );
    }
  }, [cameraRef, macroMode] );

  useEffect( ( ) => {
    applyMacroFocus( );
  }, [applyMacroFocus] );

  const outputs = frameOutput
    ? [photoOutput, frameOutput]
    : [photoOutput];

  const gesture
    = Platform.OS === "android"
      ? Gesture.Simultaneous( tapToFocus, pinchToZoom )
      : Gesture.Simultaneous( tapToFocus, panToZoom, pinchToZoom );

  // Note that overflow-hidden handles what seems to be a bug in android in
  // which the Camera overflows its view
  return (
    <>
      <GestureDetector gesture={gesture} className="overflow-hidden">
        <Camera
          // Shared props between StandardCamera and AICamera
          ref={cameraRef}
          constraints={[{ resolutionBias: photoOutput }]}
          device={device}
          // we can't use the native zoom since it doesn't expose a zoom value to JS
          enableNativeZoomGesture={false}
          isActive={isActive}
          onError={onError}
          onStarted={applyMacroFocus}
          orientationSource="device"
          outputs={outputs}
          resizeMode={resizeMode || "cover"}
          style={StyleSheet.absoluteFill}
          zoom={zoom}
        />
      </GestureDetector>
      <FocusSquare
        animatedStyle={animatedStyle}
        tappedCoordinates={tappedCoordinates}
      />
    </>
  );
};

export default CameraView;
