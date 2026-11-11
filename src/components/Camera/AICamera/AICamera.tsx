import { useFocusEffect, useRoute } from "@react-navigation/native";
import classnames from "classnames";
import FadeInOutView from "components/Camera/FadeInOutView";
import { useCameraDevices } from "components/Camera/helpers/visionCameraWrapper";
import useRotation from "components/Camera/hooks/useRotation";
import useZoom from "components/Camera/hooks/useZoom";
import {
  ActivityIndicator, Body1, INatIcon, TaxonResult,
} from "components/SharedComponents";
import Toast from "components/SharedComponents/Toast";
import { Pressable, View } from "components/styledComponents";
import type { NoBottomTabStackScreenProps } from "navigation/types";
import type { RefObject } from "react";
import React, {
  useCallback, useEffect, useRef, useState,
} from "react";
import DeviceInfo from "react-native-device-info";
import LinearGradient from "react-native-linear-gradient";
import { Snackbar } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  CameraDevice, CameraPhotoOutput, CameraRef, CapturePhotoSettings,
} from "react-native-vision-camera";
import { VolumeManager } from "react-native-volume-manager";
import ObservationPhoto from "realmModels/ObservationPhoto";
import { BREAKPOINTS } from "sharedHelpers/breakpoint";
import convertScoreToConfidence from "sharedHelpers/convertScores";
import { completeSentinelFile, logStage } from "sharedHelpers/sentinelFiles";
import { logFirebaseEvent } from "sharedHelpers/tracking";
import {
  useDebugMode,
  useDeviceOrientation,
  useLayoutPrefs,
  useTranslation,
} from "sharedHooks";
import useInputImageTracking from "sharedHooks/useInputImageTracking";
import type { UserLocation } from "sharedHooks/useWatchPosition";
import useStore from "stores/useStore";
import colors from "styles/tailwindColors";

import type { SavePhotoOptions } from "../CameraContainer";
import { MAX_PHOTOS_ALLOWED } from "../CameraContainer";
import {
  handleCameraError,
  handleClassifierError,
  handleLog,
} from "../helpers";
import DiscardChangesSheet from "../StandardCamera/DiscardChangesSheet";
import useBackPress from "../StandardCamera/hooks/useBackPress";
import PhotoPreview from "../StandardCamera/PhotoPreview";
import AICameraButtons from "./AICameraButtons";
import FrameProcessorCamera from "./FrameProcessorCamera";
import usePredictions from "./hooks/usePredictions";

const isTablet = DeviceInfo.isTablet();

const getResultContainerClassName = ( insetsTop: number ) => {
  const widthClassName = isTablet
    ? "w-[493px]"
    : "w-[346px]";
  const phoneTopClassName = insetsTop > 0
    ? "top-14"
    : "top-8";
  const topClassName = isTablet
    ? ""
    : phoneTopClassName;

  return classnames( "self-center", widthClassName, topClassName );
};

// const exampleTaxonResult = {
//   id: 12704,
//   name: "Muscicapidae",
//   rank: "family",
//   rank_level: 30,
//   preferred_common_name: "Old World Flycatchers and Chats"
// };

interface Props {
  camera: RefObject<CameraRef | null>;
  confirmPhotosInProgress: boolean;
  device: CameraDevice;
  handleCheckmarkPress: ( ) => void;
  newPhotoUris: string[];
  setNewPhotoUris: ( newPhotoUris: string[] ) => void;
  flipCamera: ( ) => void;
  isLandscapeMode: boolean;
  toggleFlash: ( ) => void;
  takingPhoto: boolean;
  takePhotoAndStoreUri: ( options: SavePhotoOptions ) => Promise<string | undefined>;
  takePhotoOptions: CapturePhotoSettings;
  userLocation: UserLocation | null;
  hasLocationPermissions: boolean;
  requestLocationPermissions: () => void;
  photoOutput: CameraPhotoOutput;
}

// The physical camera on this side that can focus closest. VisionCamera 5 no
// longer reports minimum focus distance, but on phones with a macro mode it's
// the ultra-wide lens.
const getMacroDevice = (
  devices: CameraDevice[],
  position: CameraDevice["position"] | undefined,
) => devices.find( d => d.position === position
  && !d.isVirtualDevice
  && d.type === "ultra-wide-angle" );

// The one camera in the app: it shows live AI suggestions like the old AI
// camera and, like the old multi-capture camera, takes as many photos as the
// user wants before the checkmark moves on to the next step.
const AICamera = ( {
  camera,
  confirmPhotosInProgress,
  device: defaultDevice,
  handleCheckmarkPress,
  newPhotoUris,
  setNewPhotoUris,
  flipCamera,
  isLandscapeMode,
  toggleFlash,
  takingPhoto,
  takePhotoAndStoreUri,
  takePhotoOptions,
  userLocation,
  hasLocationPermissions,
  requestLocationPermissions,
  photoOutput,
}: Props ) => {
  const { params } = useRoute<NoBottomTabStackScreenProps<"Camera">["route"]>( );
  const addEvidence = params?.addEvidence;
  const sentinelFileName = useStore( state => state.sentinelFileName );
  const setAICameraSuggestion = useStore( state => state.setAICameraSuggestion );

  const { aiCameraSettings, setAICameraSetting } = useLayoutPrefs( );
  const { macroMode } = aiCameraSettings;
  const devices = useCameraDevices( );
  const macroDevice = macroMode
    ? getMacroDevice( devices, defaultDevice?.position )
    : undefined;
  const device = macroDevice || defaultDevice;

  const hasFlash = device?.hasFlash;
  const { isDebug } = useDebugMode( );
  const { isDefaultMode } = useLayoutPrefs( );
  const {
    handleZoomButtonPress,
    panToZoom,
    pinchToZoom,
    showZoomButton,
    zoomTextValue,
    resetZoom,
    zoom,
  } = useZoom( device );
  const {
    rotatableAnimatedStyle,
    rotation,
  } = useRotation( );
  const {
    handleTaxaDetected,
    modelLoaded,
    result,
    setResult,
  } = usePredictions( );
  const [initialVolume, setInitialVolume] = useState<number | null>( null );
  const [deletePhotoMode, setDeletePhotoMode] = useState( false );
  const [showMaxPhotosAlert, setShowMaxPhotosAlert] = useState( false );
  // The last confident prediction the shutter was pressed on, offered as the
  // AI suggestion once the user is done taking photos
  const visionResultRef = useRef<typeof result>( null );

  const cameraUris = useStore( state => state.cameraUris );
  const photoLibraryUris = useStore( state => state.photoLibraryUris );
  const prepareCamera = useStore( state => state.prepareCamera );
  const deletePhotoFromObservation = useStore( state => state.deletePhotoFromObservation );
  const { trackImageDeleted } = useInputImageTracking( );
  const { screenWidth } = useDeviceOrientation( );

  const totalObsPhotoUris = cameraUris.length + photoLibraryUris.length;
  const disallowAddingPhotos = totalObsPhotoUris >= MAX_PHOTOS_ALLOWED;
  // newPhotoUris tracks photos taken in *this* visit to the camera; photos
  // the observation already had don't need a discard prompt or a checkmark
  const photosTaken = newPhotoUris.length > 0 && totalObsPhotoUris > 0;
  const {
    handleBackButtonPress,
    navigateBackOrExitFlow,
    setShowDiscardSheet,
    showDiscardSheet,
  } = useBackPress( photosTaken );

  const userDisabledLocation = aiCameraSettings.locationDisabled;
  // hasLocationPermissions is undefined until permissions have been checked
  const useLocation = !!hasLocationPermissions && !userDisabledLocation;
  const [locationStatusVisible, setLocationStatusVisible] = useState( false );

  const toggleLocation = () => {
    if ( !useLocation && !hasLocationPermissions ) {
      requestLocationPermissions( );
      return;
    }
    setAICameraSetting( "locationDisabled", !userDisabledLocation );
    // Always show status when button is pressed
    setLocationStatusVisible( true );
  };

  const handleLocationStatusEnd = ( ) => {
    setLocationStatusVisible( false );
  };

  const { t } = useTranslation();

  const resetCameraOnFocus = useCallback( ( ) => {
    setResult( null );
    resetZoom( );
  }, [resetZoom, setResult] );

  useFocusEffect(
    useCallback( ( ) => {
      // Start from the observation's current photos every time the camera
      // comes into view, e.g. after backing out of Suggestions
      prepareCamera( );
      visionResultRef.current = null;
    }, [prepareCamera] ),
  );

  // only show predictions when rank is order or lower, like we do on Seek
  const showPrediction = ( result && result?.taxon?.rank_level <= 40 ) || false;

  const insets = useSafeAreaInsets( );

  const toggleMacro = ( ) => {
    resetZoom( );
    setAICameraSetting( "macroMode", !macroMode );
  };

  const onFlipCamera = () => {
    flipCamera( );
  };

  const handleTakePhoto = useCallback( async ( ) => {
    if ( takingPhoto ) return;
    if ( disallowAddingPhotos ) {
      setShowMaxPhotosAlert( true );
      return;
    }
    await logStage( sentinelFileName, "take_photo_start" );
    logFirebaseEvent( "ai_camera_shutter_tap", { hasLocationPermissions } );
    if ( showPrediction && result ) {
      visionResultRef.current = result;
    }
    await takePhotoAndStoreUri( { } );
  }, [
    disallowAddingPhotos,
    hasLocationPermissions,
    result,
    sentinelFileName,
    showPrediction,
    takePhotoAndStoreUri,
    takingPhoto,
  ] );

  const handleConfirmPhotos = useCallback( ( ) => {
    // this feels a little duplicative, but we're currently using aICameraSuggestion
    // to show the loading screen in Suggestions *without* setting an observation.taxon.
    // Adding photos to an existing observation doesn't go through Suggestions.
    setAICameraSuggestion( addEvidence
      ? null
      : visionResultRef.current );
    handleCheckmarkPress( );
  }, [addEvidence, handleCheckmarkPress, setAICameraSuggestion] );

  const deletePhotoByUri = useCallback( async ( photoUri: string ) => {
    deletePhotoFromObservation( photoUri );
    await ObservationPhoto.deletePhoto( photoUri );
    trackImageDeleted( photoUri );
    setNewPhotoUris( newPhotoUris.filter( uri => uri !== photoUri ) );
  }, [deletePhotoFromObservation, newPhotoUris, setNewPhotoUris, trackImageDeleted] );

  const handleDiscard = useCallback( async ( ) => {
    await Promise.all( newPhotoUris.map( uri => deletePhotoByUri( uri ) ) );
    setNewPhotoUris( [] );
    await completeSentinelFile( sentinelFileName );
    navigateBackOrExitFlow( );
  }, [
    deletePhotoByUri,
    navigateBackOrExitFlow,
    newPhotoUris,
    sentinelFileName,
    setNewPhotoUris,
  ] );

  useEffect( () => {
    if ( initialVolume === null ) {
      // Fetch the current volume to set the initial state
      VolumeManager.getVolume()
        .then( volume => {
          setInitialVolume( volume.volume );
        } );
    }

    const volumeListener = VolumeManager.addVolumeListener( async ( ) => {
      if ( initialVolume !== null ) {
        // Hardware volume button pressed - take a photo
        await handleTakePhoto();

        // Revert the volume to its previous state
        VolumeManager.setVolume( initialVolume );
      }
    } );

    // Suppress the native volume UI
    VolumeManager.showNativeVolumeUI( { enabled: false } );

    return () => {
      volumeListener.remove();
      VolumeManager.showNativeVolumeUI( { enabled: true } );
    };
  }, [handleTakePhoto, initialVolume] );

  const handleClose = async ( ) => {
    // Leaving with photos asks first; the discard sheet finishes the sentinel
    if ( !photosTaken ) {
      await completeSentinelFile( sentinelFileName );
    }
    handleBackButtonPress( );
  };

  const isLargeScreen = screenWidth > BREAKPOINTS.md;
  const showPhotoPreview = cameraUris.length > 0 || takingPhoto;

  return (
    <>
      {device && (
        <View className="w-full h-full absolute z-0">
          <FrameProcessorCamera
            cameraRef={camera}
            device={device}
            onTaxaDetected={handleTaxaDetected}
            onCameraError={handleCameraError}
            onClassifierError={handleClassifierError}
            onLog={handleLog}
            panToZoom={panToZoom}
            photoOutput={photoOutput}
            pinchToZoom={pinchToZoom}
            takingPhoto={takingPhoto}
            inactive={confirmPhotosInProgress}
            resetCameraOnFocus={resetCameraOnFocus}
            userLocation={userLocation}
            useLocation={useLocation}
            zoom={zoom}
            macroMode={macroMode}
          />
        </View>
      )}
      <LinearGradient
        colors={[colors.black, "rgba(0, 0, 0, 0)"]}
        locations={[
          0.001,
          isTablet && isLandscapeMode
            ? 0.3
            : 1,
        ]}
        className="w-full h-[219px]"
      >
        <View
          className={getResultContainerClassName( insets.top )}
        >
          {showPrediction && result
            ? (
              <TaxonResult
                asListItem={false}
                clearBackground
                confidence={
                  isDefaultMode
                    ? undefined
                    : convertScoreToConfidence( result?.combined_score )
                }
                unpressable
                taxon={result?.taxon}
                testID={`AICamera.taxa.${result?.taxon?.id}`}
                white
                // my thinking here is that we're already making this API call over and over
                // every second when a prediction comes back, and we likely don't want to
                // 3x that in low network conditions if every request is failing
                retryQuery={false}
              />
            )
            : (
              <Body1 className="text-white self-center text-center mt-[22px]">
                {modelLoaded
                  ? t( "Point-the-camera-at-an-animal-plant-or-fungus" )
                  : t( "Loading-iNaturalists-AI-Camera" )}
              </Body1>
            )}
          {locationStatusVisible && (
            <Toast
              icon={useLocation
                ? "map-marker-outline"
                : "map-marker-outline-off"}
              onHide={handleLocationStatusEnd}
              text={useLocation
                ? t( "Using-location" )
                : t( "Ignoring-location" )}
              variant="dark"
              wrapperClassName="mt-4"
            />
          )}
          {isDebug && result && (
            <Body1 className="text-deeppink self-center mt-[22px]">
              {`Age of result: ${Date.now() - result.timestamp}ms`}
            </Body1>
          )}
        </View>
      </LinearGradient>
      {!modelLoaded && (
        <View className="absolute left-1/2 top-1/2">
          <View className="right-[57px] bottom-[57px]">
            <INatIcon name="inaturalist" size={114} color={colors.white} />
          </View>
        </View>
      )}
      <FadeInOutView takingPhoto={takingPhoto} cameraType="Standard" />
      {confirmPhotosInProgress && (
        <View className="absolute w-full h-full justify-center items-center">
          <ActivityIndicator size={50} color={colors.white} />
        </View>
      )}
      {deletePhotoMode && (
        // Tapping anywhere outside the photos leaves delete mode
        <Pressable
          accessibilityRole="button"
          className="absolute w-full h-full"
          onPress={( ) => setDeletePhotoMode( false )}
        />
      )}
      {showPhotoPreview && (
        <View
          className="absolute left-[72px] right-[72px]"
          style={{ bottom: insets.bottom + 32 + 74 + 16 }}
          pointerEvents="box-none"
        >
          <PhotoPreview
            deletePhotoMode={deletePhotoMode}
            rotation={rotation}
            setDeletePhotoMode={setDeletePhotoMode}
            takingPhoto={takingPhoto}
            isLandscapeMode={isLandscapeMode}
            isLargeScreen={isLargeScreen}
            isTablet={isTablet}
            photoUris={cameraUris}
            onDelete={deletePhotoByUri}
          />
        </View>
      )}
      <AICameraButtons
        handleZoomButtonPress={handleZoomButtonPress}
        flipCamera={onFlipCamera}
        hasFlash={hasFlash}
        handleClose={handleClose}
        photosTaken={photosTaken}
        handleCheckmarkPress={handleConfirmPhotos}
        confirmDisabled={takingPhoto || confirmPhotosInProgress}
        rotatableAnimatedStyle={rotatableAnimatedStyle}
        showPrediction={showPrediction}
        showZoomButton={showZoomButton}
        takePhoto={handleTakePhoto}
        disallowAddingPhotos={disallowAddingPhotos}
        takePhotoOptions={takePhotoOptions}
        takingPhoto={takingPhoto}
        toggleFlash={toggleFlash}
        zoomTextValue={zoomTextValue}
        useLocation={useLocation}
        toggleLocation={toggleLocation}
        macroMode={macroMode}
        toggleMacro={toggleMacro}
        completeSentinelFile={() => completeSentinelFile( sentinelFileName )}
      />
      <Snackbar visible={showMaxPhotosAlert} onDismiss={() => setShowMaxPhotosAlert( false )}>
        {t( "You-can-only-add-20-photos-per-observation" )}
      </Snackbar>
      <DiscardChangesSheet
        setShowDiscardSheet={setShowDiscardSheet}
        hidden={!showDiscardSheet}
        onDiscard={handleDiscard}
      />
    </>
  );
};

export default AICamera;
