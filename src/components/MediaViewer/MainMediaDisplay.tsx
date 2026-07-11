import Slider from "@react-native-community/slider";
import SoundContainer from "components/ObsDetailsSharedComponents/Media/SoundContainer";
import {
  INatIconButton,
  TransparentCircleButton,
} from "components/SharedComponents";
import { Text, View } from "components/styledComponents";
import React, {
  useCallback, useMemo, useRef, useState,
} from "react";
import { ActivityIndicator, PixelRatio, StyleSheet } from "react-native";
import type { PanGesture } from "react-native-gesture-handler";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import type { CarouselRenderItem, ICarouselInstance } from "react-native-reanimated-carousel";
import Carousel from "react-native-reanimated-carousel";
import Photo from "realmModels/Photo";
import { saveAnimalCrop } from "sharedHelpers/animalCropLog";
import { saveBrightness } from "sharedHelpers/brightnessLog";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import { openExternalWebBrowser } from "sharedHelpers/util";
import useLiveToneMappedBrightnessUri from "sharedHelpers/useLiveToneMappedBrightnessUri";
import useDeviceOrientation from "sharedHooks/useDeviceOrientation";
import useTranslation from "sharedHooks/useTranslation";
import colors from "styles/tailwindColors";

import AttributionButton from "./AttributionButton";
import CustomImageZoom from "./CustomImageZoom";
import type { SharedZoomableImageRef } from "./SharedZoomableImage";

interface PhotoItem {
  attribution?: string;
  id?: number;
  licenseCode?: string;
  localFilePath?: string;
  type: "photo";
  url: string;
}

interface SoundItem {
  file_url: string;
  hidden: boolean;
  type: "sound";
}

// Exposure slider: values are in stops (EV). Each +1 stop doubles the
// scene-referred light, so the gain applied to the image is 2^stops, not
// stops itself — the exponential curve is the whole point of measuring in
// stops rather than a plain 0-5x multiplier.
const EXPOSURE_STOPS_MIN = -1;
const EXPOSURE_STOPS_MAX = 4;
const EXPOSURE_STOPS_DEFAULT = 0;
const EXPOSURE_TICK_STOPS = [-1, 0, 1, 2, 3, 4];
const BRIGHTNESS_DEFAULT = 1.0;
const stopsToGain = ( stops: number ) => 2 ** stops;
const formatStop = ( stop: number ) => ( stop > 0 ? `+${stop}` : `${stop}` );
const styles = StyleSheet.create( {
  gestureHandlerRoot: { flex: 1 },
} );
const sliderStyle = { flex: 1, height: 40 };
const tickRowStyle = { justifyContent: "space-between" as const, bottom: 2 };
const labelRowStyle = { justifyContent: "space-between" as const };
const roundIconButtonClass = "bg-black/50 items-center justify-center "
  + "rounded-full h-[40px] w-[40px] ml-2";

interface Props {
  autoPlaySound?: boolean; // automatically start playing a sound when it is visible
  editable?: boolean;
  horizontalScroll: React.Ref<ICarouselInstance>;
  onCropPhoto?: Function;
  onDeletePhoto: ( uri: string ) => void;
  onClose: ( ) => void;
  onDeleteSound: ( uri: string ) => void;
  onLongPressPhoto?: ( uri: string ) => void;
  photos: Omit<PhotoItem, "type">[];
  sounds?: Omit<SoundItem, "type">[];
  selectedMediaIndex: number;
  setSelectedMediaIndex: ( index: number ) => void;
}

const MainMediaDisplay = ( {
  autoPlaySound,
  editable,
  horizontalScroll,
  onCropPhoto,
  onDeletePhoto,
  onDeleteSound,
  onClose,
  onLongPressPhoto,
  photos,
  sounds = [],
  selectedMediaIndex,
  setSelectedMediaIndex,
}: Props ) => {
  const { t } = useTranslation( );
  const { screenWidth, screenHeight } = useDeviceOrientation( );
  const [zooming, setZooming] = useState( false );
  const [brightnessStops, setBrightnessStops] = useState( EXPOSURE_STOPS_DEFAULT );
  const brightness = stopsToGain( brightnessStops );
  const [brightnessSaved, setBrightnessSaved] = useState( false );
  const [brightnessSaving, setBrightnessSaving] = useState( false );
  const [showBrightnessSlider, setShowBrightnessSlider] = useState( false );
  const imageDimensionsRef = useRef<{ width: number; height: number } | null>( null );
  const currentZoomRefRef = useRef<SharedZoomableImageRef | null>( null );
  const items = useMemo( ( ) => ( [
    ...photos.map( photo => ( { ...photo, type: "photo" as const } ) ),
    ...sounds.map( sound => ( { ...sound, type: "sound" as const } ) ),
  ] ), [photos, sounds] );

  // Live preview for whichever photo the brightness slider is currently
  // editing, using the debounced exposure adjustment (the same one that gets
  // saved — see adjustImageBrightness) so the preview matches the final look
  // exactly.
  const selectedPhoto = photos[selectedMediaIndex];
  const selectedPhotoUri = selectedPhoto
    ? Photo.displayLocalOrRemoteLargePhoto( selectedPhoto )
    : undefined;
  // Capped to screen resolution (not fully uncapped) since this reprocesses
  // on every settled slider tick — full-resolution processing is too slow
  // to keep up with interactive dragging.
  const liveBrightnessMaxDimension = Math.round(
    Math.max( screenWidth, screenHeight ) * PixelRatio.get( ),
  );
  const liveBrightnessUri = useLiveToneMappedBrightnessUri(
    selectedPhotoUri,
    brightness,
    liveBrightnessMaxDimension,
  );
  const liveBrightnessReady = Boolean(
    liveBrightnessUri && liveBrightnessUri !== selectedPhotoUri,
  );

  // On the render right after a photo is removed, selectedMediaIndex can still
  // point at the deleted index
  const safeDefaultIndex = Math.max(
    0,
    Math.min( selectedMediaIndex, items.length - 1 ),
  );

  const deletePhotoLabel = t( "Delete-photo" );
  const deleteSoundLabel = t( "Delete-sound" );
  const cropPhotoLabel = t( "CROP-PHOTO" );

  const handleImageDimensionsChange = useCallback( ( dims: { width: number; height: number } ) => {
    imageDimensionsRef.current = dims;
  }, [] );

  const handleInteractionEnd = useCallback( ( ) => {
    const currentIndex = selectedMediaIndex;
    if ( currentIndex >= photos.length ) return;

    const photo = photos[currentIndex];
    const photoUrl = Photo.displayLocalOrRemoteLargePhoto( photo );
    const zoomRef = currentZoomRefRef.current;
    const imageDims = imageDimensionsRef.current;

    if ( !zoomRef || !imageDims ) return;

    try {
      const transform = zoomRef.readTransform( );
      // Convert zoom transform to normalized crop (0-1 range)
      const crop = imageZoomTransformToNormalizedCrop(
        imageDims.width,
        imageDims.height,
        screenWidth,
        screenHeight,
        Math.min( screenWidth, screenHeight ) * 0.8, // crop frame is ~80% of viewport
        transform,
      );
      saveAnimalCrop( photoUrl, crop );
    } catch {
      // Silently fail if we can't read the transform or save the crop
    }
  }, [photos, selectedMediaIndex, screenWidth, screenHeight] );

  const renderPhoto = ( photo: PhotoItem, photoIndex: number ) => {
    const uri = Photo.displayLocalOrRemoteLargePhoto( photo );
    const hasAttribution = photo?.attribution;
    const isSelected = photoIndex === selectedMediaIndex;
    const isEditingBrightness = isSelected && brightness !== BRIGHTNESS_DEFAULT;
    // Only ever show the exposure-based adjustment (power->linear->power, see
    // adjustImageBrightness). Until the debounced processing finishes we show
    // the unadjusted image rather than a CSS brightness filter, which uses a
    // different (gamma-encoded multiply) computation and made the preview
    // flash between the two as processing completed and restarted per tick.
    const displayUri = isEditingBrightness && liveBrightnessReady
      ? liveBrightnessUri
      : uri;
    return (
      <View className="flex-1">
        <CustomImageZoom
          uri={displayUri}
          resetKey={uri}
          setZooming={setZooming}
          selectedMediaIndex={selectedMediaIndex}
          brightness={BRIGHTNESS_DEFAULT}
          zoomRef={( ref: SharedZoomableImageRef | null ) => {
            if ( photoIndex === selectedMediaIndex ) {
              currentZoomRefRef.current = ref;
            }
          }}
          onSwipeToClose={onClose}
          onLongPress={onLongPressPhoto
            ? ( ) => onLongPressPhoto( uri )
            : undefined}
          onImageDimensionsChange={handleImageDimensionsChange}
          onInteractionEnd={handleInteractionEnd}
        />
        {
          editable
            ? (
              <View className="absolute bottom-4 right-4 flex-row items-center">
                { onCropPhoto && (
                  <TransparentCircleButton
                    onPress={( ) => onCropPhoto( photo )}
                    icon="crop"
                    color={colors.white}
                    accessibilityLabel={cropPhotoLabel}
                    testID="EvidenceList.editSquareCrop"
                    optionalClasses="mr-2"
                  />
                ) }
                <TransparentCircleButton
                  onPress={( ) => onDeletePhoto(
                    Photo.getLocalPhotoUri( photo.localFilePath )
                    || photo.url,
                  )}
                  icon="trash-outline"
                  color={colors.white}
                  accessibilityLabel={deletePhotoLabel}
                />
              </View>
            )
            : (
              <View className="absolute top-4 right-4 flex-row items-center">
                { hasAttribution && (
                  <AttributionButton
                    licenseCode={photo.licenseCode}
                    attribution={photo.attribution}
                    optionalClasses="mr-2"
                  />
                ) }
                { photo.id && (
                  <TransparentCircleButton
                    onPress={( ) => openExternalWebBrowser(
                      `https://www.inaturalist.org/photos/${photo.id}`,
                    )}
                    icon="globe-outline"
                    color={colors.white}
                    accessibilityLabel={t( "View-in-browser" )}
                  />
                ) }
              </View>
            )
        }
        <View className="absolute bottom-4 left-4">
          <INatIconButton
            onPress={( ) => setShowBrightnessSlider( prev => !prev )}
            icon="sliders"
            color={showBrightnessSlider || brightness !== BRIGHTNESS_DEFAULT
              ? colors.inatGreen
              : colors.white}
            className="bg-black/50 items-center justify-center rounded-full h-[40px] w-[40px]"
            accessibilityLabel={t( "Adjust-brightness" )}
            testID="MediaViewer.brightnessButton"
            size={20}
          />
        </View>
        { showBrightnessSlider && (
          <View className="absolute bottom-16 left-0 right-0 px-4 py-2">
            <View className="bg-black/60 rounded-xl px-3 py-2 flex-row items-center">
              <View className="flex-1">
                <View className="justify-center">
                  <Slider
                    style={sliderStyle}
                    minimumValue={EXPOSURE_STOPS_MIN}
                    maximumValue={EXPOSURE_STOPS_MAX}
                    minimumTrackTintColor={colors.inatGreen}
                    maximumTrackTintColor={colors.white}
                    thumbTintColor={colors.white}
                    value={brightnessStops}
                    onValueChange={val => {
                      setBrightnessStops( val );
                      setBrightnessSaved( false );
                    }}
                    tapToSeek
                    accessibilityLabel={t( "Adjust-brightness" )}
                  />
                  <View
                    className="absolute left-0 right-0 flex-row px-1"
                    style={tickRowStyle}
                    pointerEvents="none"
                  >
                    { EXPOSURE_TICK_STOPS.map( stop => (
                      <View key={stop} className="w-px h-2 bg-white/70" />
                    ) ) }
                  </View>
                </View>
                <View className="flex-row px-1" style={labelRowStyle}>
                  { EXPOSURE_TICK_STOPS.map( stop => (
                    <Text key={stop} className="text-white/70 text-[10px]">
                      { formatStop( stop ) }
                    </Text>
                  ) ) }
                </View>
              </View>
              { brightness !== BRIGHTNESS_DEFAULT && (
                <>
                  { brightnessSaving
                    ? (
                      <View className={roundIconButtonClass}>
                        <ActivityIndicator
                          size="small"
                          color={colors.white}
                        />
                      </View>
                    )
                    : (
                      <INatIconButton
                        className={roundIconButtonClass}
                        onPress={async ( ) => {
                          setBrightnessSaving( true );
                          await saveBrightness( photo.url, brightness );
                          setBrightnessSaving( false );
                          setBrightnessSaved( true );
                        }}
                        icon="label"
                        color={brightnessSaved
                          ? colors.white
                          : colors.inatGreen}
                        size={20}
                        accessibilityLabel={t( "Save-brightness-label" )}
                        testID="MediaViewer.saveBrightnessButton"
                      />
                    ) }
                  <TransparentCircleButton
                    onPress={( ) => setBrightnessStops( EXPOSURE_STOPS_DEFAULT )}
                    icon="close"
                    color={colors.white}
                    accessibilityLabel={t( "Reset-brightness" )}
                    testID="MediaViewer.resetBrightnessButton"
                    optionalClasses="ml-2"
                  />
                </>
              ) }
            </View>
          </View>
        ) }
      </View>
    );
  };

  const soundSwipeToCloseGesture = Gesture.Pan()
    .runOnJS( true )
    .maxPointers( 1 )
    .activeOffsetY( 15 )
    .failOffsetX( [-15, 15] )
    .onUpdate( ( { translationY, velocityY } ) => {
      if ( translationY > 50 && velocityY > 500 ) {
        onClose();
      }
    } );

  const renderSound = ( sound: SoundItem ) => (
    <GestureDetector gesture={soundSwipeToCloseGesture}>
      <View
        collapsable={false}
        className="flex-1 justify-center items-center"
      >
        <SoundContainer
          autoPlay={autoPlaySound}
          sizeClass="h-72 w-screen"
          sound={sound}
          isVisible={items.indexOf( sound ) === selectedMediaIndex}
        />
        {
          editable && (
            <View className="absolute bottom-4 right-4">
              <TransparentCircleButton
                onPress={( ) => onDeleteSound( sound.file_url )}
                icon="trash-outline"
                accessibilityLabel={deleteSoundLabel}
              />
            </View>
          )
        }
      </View>
    </GestureDetector>
  );

  const renderItem: CarouselRenderItem<PhotoItem | SoundItem> = ( { item } ) => {
    if ( item.type === "photo" ) {
      // `item` is drawn from `items` (a freshly-mapped array), never from
      // `photos` itself, so `photos.indexOf(item)` can never match by
      // reference and always returns -1. `items` lists photos before
      // sounds in the same order as `photos`, so its index lines up.
      const photoIndex = items.indexOf( item );
      return renderPhoto( item as PhotoItem, photoIndex );
    }
    return renderSound( item as SoundItem );
  };

  // Must be stable: onConfigurePanGesture is a useMemo dependency inside the Carousel
  const onConfigurePanGesture = useCallback( ( panGesture: PanGesture ) => {
    panGesture
      // Page only on clearly horizontal drags; leave vertical intent as swipe-to-close
      .activeOffsetX( [-10, 10] )
      .failOffsetY( [-15, 15] )
      // A second finger means pinch-to-zoom do not pan
      .maxPointers( 1 );
  }, [] );

  return (
    <View className="flex-1">
      <GestureHandlerRootView style={styles.gestureHandlerRoot}>
        <Carousel
          // Include the item count in the key so the carousel fully
          // remounts when media is added or removed.
          key={`MediaViewerCarousel-${screenWidth}-${items.length}`}
          testID="MediaViewer.carousel"
          ref={horizontalScroll}
          data={items}
          renderItem={renderItem}
          defaultIndex={safeDefaultIndex}
          loop={false}
          width={screenWidth}
          // Disable scrolling when image is zooming
          enabled={!zooming}
          onSnapToItem={setSelectedMediaIndex}
          onConfigurePanGesture={onConfigurePanGesture}
        />
      </GestureHandlerRootView>
    </View>
  );
};

export default MainMediaDisplay;
