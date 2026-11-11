import CameraFlip from "components/Camera/Buttons/CameraFlip";
import Close from "components/Camera/Buttons/Close";
import Flash from "components/Camera/Buttons/Flash";
import GreenCheckmark from "components/Camera/Buttons/GreenCheckmark";
import Location from "components/Camera/Buttons/Location";
import Macro from "components/Camera/Buttons/Macro";
import PhotoLibraryIcon from "components/Camera/Buttons/PhotoLibraryIcon";
import TakePhoto from "components/Camera/Buttons/TakePhoto";
import Zoom from "components/Camera/Buttons/Zoom";
import RotatableIconWrapper from "components/Camera/RotatableIconWrapper";
import TabletButtons from "components/Camera/TabletButtons";
import { View } from "components/styledComponents";
import React from "react";
import DeviceInfo from "react-native-device-info";
import type { AnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CapturePhotoSettings } from "react-native-vision-camera";
import { useLayoutPrefs } from "sharedHooks";

const isTablet = DeviceInfo.isTablet();

interface Props {
  confirmDisabled: boolean;
  disallowAddingPhotos: boolean;
  handleCheckmarkPress: ( ) => void;
  handleZoomButtonPress: ( ) => void;
  flipCamera: ( ) => void;
  handleClose: ( ) => void;
  hasFlash: boolean;
  photosTaken: boolean;
  rotatableAnimatedStyle: AnimatedStyle;
  showPrediction: boolean;
  showZoomButton: boolean;
  takePhoto: () => Promise<void>;
  takePhotoOptions: CapturePhotoSettings;
  takingPhoto: boolean;
  toggleFlash: ( ) => void;
  zoomTextValue: string;
  useLocation: boolean;
  toggleLocation: ( ) => void;
  macroMode: boolean;
  toggleMacro: ( ) => void;
  completeSentinelFile: ( ) => Promise<void>;
}

const AICameraButtons = ( {
  confirmDisabled,
  disallowAddingPhotos,
  handleCheckmarkPress,
  handleZoomButtonPress,
  flipCamera,
  handleClose,
  hasFlash,
  photosTaken,
  rotatableAnimatedStyle,
  showPrediction,
  showZoomButton,
  takePhoto,
  takePhotoOptions,
  takingPhoto,
  toggleFlash,
  zoomTextValue,
  useLocation,
  toggleLocation,
  macroMode,
  toggleMacro,
  completeSentinelFile,
}: Props ) => {
  const { bottom } = useSafeAreaInsets( );
  const { isDefaultMode } = useLayoutPrefs();
  if ( isTablet ) {
    return (
      <TabletButtons
        handleZoomButtonPress={handleZoomButtonPress}
        // Photos can be taken before the model has loaded, they just won't
        // come with a live suggestion
        disabled={disallowAddingPhotos || takingPhoto}
        disabledPhotoLibrary={takingPhoto}
        // TODO: once we re-visit tablet views, we'll want to ensure users cannot spam the submit
        // button while taking photos. see:
        // https://linear.app/inaturalist/issue/MOB-1084/multicapture-camera-multiple-copies-of-photos-can-be-saved
        // confirmDisabled={false}
        flipCamera={flipCamera}
        handleCheckmarkPress={confirmDisabled
          ? undefined
          : handleCheckmarkPress}
        handleClose={handleClose}
        hasFlash={hasFlash}
        hasPhotoLibraryButton
        photosTaken={photosTaken}
        rotatableAnimatedStyle={rotatableAnimatedStyle}
        showPrediction={showPrediction}
        showZoomButton={showZoomButton}
        takePhoto={takePhoto}
        takePhotoOptions={takePhotoOptions}
        toggleFlash={toggleFlash}
        zoomTextValue={zoomTextValue}
        useLocation={useLocation}
        toggleLocation={toggleLocation}
        isDefaultMode={isDefaultMode}
        completeSentinelFile={completeSentinelFile}
      />
    );
  }
  return (
    <View
      className="absolute right-5 left-5"
      pointerEvents="box-none"
      style={{ bottom: bottom + 32 }}
    >
      <View
        className="absolute left-0 bottom-[17px] h-full justify-end flex gap-y-9"
        pointerEvents="box-none"
      >
        <View>
          <Close
            handleClose={handleClose}
            rotatableAnimatedStyle={rotatableAnimatedStyle}
          />
        </View>
      </View>
      <View
        className="absolute right-0 bottom-[6px] h-full justify-end items-end flex gap-y-9"
        pointerEvents="box-none"
      >
        {!isDefaultMode && (
          <View>
            <Location
              toggleLocation={toggleLocation}
              useLocation={useLocation}
              rotatableAnimatedStyle={rotatableAnimatedStyle}
            />
          </View>
        )}
        <View>
          <Macro
            toggleMacro={toggleMacro}
            macroMode={macroMode}
            rotatableAnimatedStyle={rotatableAnimatedStyle}
          />
        </View>
        {showZoomButton && (
          <View>
            <Zoom
              zoomTextValue={zoomTextValue}
              handleZoomButtonPress={handleZoomButtonPress}
              rotatableAnimatedStyle={rotatableAnimatedStyle}
            />
          </View>
        )}
        <View>
          <Flash
            toggleFlash={toggleFlash}
            hasFlash={hasFlash}
            takePhotoOptions={takePhotoOptions}
            rotatableAnimatedStyle={rotatableAnimatedStyle}
          />
        </View>
        <View>
          <CameraFlip
            flipCamera={flipCamera}
            rotatableAnimatedStyle={rotatableAnimatedStyle}
          />
        </View>
        <View>
          <PhotoLibraryIcon
            rotatableAnimatedStyle={rotatableAnimatedStyle}
            disabled={takingPhoto}
            completeSentinelFile={completeSentinelFile}
          />
        </View>
      </View>
      <View className="flex-row justify-center items-center w-full" pointerEvents="box-none">
        <TakePhoto
          disabled={disallowAddingPhotos || takingPhoto}
          takePhoto={takePhoto}
          showPrediction={showPrediction}
          rotatableAnimatedStyle={rotatableAnimatedStyle}
        />
        {photosTaken && (
          // Sits just right of the shutter, clear of the column of options
          <View className="absolute left-1/2 ml-[56px] h-10 w-10">
            <RotatableIconWrapper
              rotatableAnimatedStyle={rotatableAnimatedStyle}
              containerClass="h-10 w-10 rounded-full justify-center items-center"
            >
              <GreenCheckmark
                disabled={confirmDisabled}
                handleCheckmarkPress={handleCheckmarkPress}
              />
            </RotatableIconWrapper>
          </View>
        )}
      </View>
    </View>
  );
};

export default AICameraButtons;
