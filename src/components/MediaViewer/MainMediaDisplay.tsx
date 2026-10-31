import SoundContainer from "components/ObsDetailsSharedComponents/Media/SoundContainer";
import {
  INatIconButton,
  TransparentCircleButton,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { StyleSheet } from "react-native";
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
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import { openExternalWebBrowser } from "sharedHelpers/util";
import useDeviceOrientation from "sharedHooks/useDeviceOrientation";
import {
  EXPOSURE_STOPS_MAX,
  EXPOSURE_STOPS_MIN,
} from "sharedHooks/useIdentifyPhotoBrightness";
import useIdentifyPhotoControls from "sharedHooks/useIdentifyPhotoControls";
import useTranslation from "sharedHooks/useTranslation";
import colors from "styles/tailwindColors";

import AttributionButton from "./AttributionButton";
import CustomImageZoom, { SUBJECT_CROP_FRAME_FRACTION } from "./CustomImageZoom";
import { zoomAroundCentre, ZoomBrightnessSliders } from "./IdentifyPhoto";
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

const BRIGHTNESS_DEFAULT = 1.0;
const styles = StyleSheet.create( {
  gestureHandlerRoot: { flex: 1 },
} );
const iconBtnClass = "bg-black/50 items-center justify-center rounded-full h-[40px] w-[40px]";

interface Props {
  autoPlaySound?: boolean; // automatically start playing a sound when it is visible
  // Auto-frame each photo to its detected subject. Off by default so the
  // viewer never runs subject detection on the user's own images; only
  // enabled for other people's photos (Explore, taxon media, etc.). Own
  // images are still detected/cropped in the dedicated crop editor.
  autoDetectSubject?: boolean;
  editable?: boolean;
  horizontalScroll: React.Ref<ICarouselInstance>;
  onCropPhoto?: Function;
  onDeletePhoto: ( uri: string ) => void;
  onClose: ( ) => void;
  onDeleteSound: ( uri: string ) => void;
  onSharePhoto?: ( uri: string ) => void;
  photos: Omit<PhotoItem, "type">[];
  sounds?: Omit<SoundItem, "type">[];
  selectedMediaIndex: number;
  setSelectedMediaIndex: ( index: number ) => void;
}

const MainMediaDisplay = ( {
  autoPlaySound,
  autoDetectSubject = false,
  editable,
  horizontalScroll,
  onCropPhoto,
  onDeletePhoto,
  onDeleteSound,
  onClose,
  onSharePhoto,
  photos,
  sounds = [],
  selectedMediaIndex,
  setSelectedMediaIndex,
}: Props ) => {
  const { t } = useTranslation( );
  const { screenWidth, screenHeight } = useDeviceOrientation( );
  const [zooming, setZooming] = useState( false );
  const imageDimensionsRef = useRef<{ width: number; height: number } | null>( null );
  const currentZoomRefRef = useRef<SharedZoomableImageRef | null>( null );
  const items = useMemo( ( ) => ( [
    ...photos.map( photo => ( { ...photo, type: "photo" as const } ) ),
    ...sounds.map( sound => ( { ...sound, type: "sound" as const } ) ),
  ] ), [photos, sounds] );

  const selectedPhoto = photos[selectedMediaIndex];

  // The same zoom + exposure sliders as the crop editor: brightness drives the
  // CSS filter live and is recorded to the brightness log on release.
  const {
    brightness,
    brightnessStops,
    handleBrightnessChange,
    handleBrightnessComplete,
    handleScaleChange,
    handleZoomChange,
    zoomScale,
  } = useIdentifyPhotoControls( {
    brightnessKey: selectedPhoto?.url,
    applyZoom: scale => {
      const img = currentZoomRefRef.current;
      if ( img ) zoomAroundCentre( img, scale, screenWidth / 2, screenHeight / 2 );
    },
    // Each photo keeps its own framing, so sync the slider to it on paging
    // instead of resetting.
    skipZoomReset: true,
  } );

  useEffect( ( ) => {
    const img = currentZoomRefRef.current;
    if ( img ) handleScaleChange( img.readTransform( ).scale );
  }, [handleScaleChange, selectedMediaIndex] );

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
    const photoUrl = Photo.displayLocalOrRemoteOriginalPhoto( photo );
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
        // Must match the framing fraction so a framed subject round-trips.
        Math.min( screenWidth, screenHeight ) * SUBJECT_CROP_FRAME_FRACTION,
        transform,
      );
      saveAnimalCrop( photoUrl, crop );
    } catch {
      // Silently fail if we can't read the transform or save the crop
    }
  }, [photos, selectedMediaIndex, screenWidth, screenHeight] );

  const renderPhoto = ( photo: PhotoItem, photoIndex: number ) => {
    const uri = Photo.displayLocalOrRemoteOriginalPhoto( photo );
    const hasAttribution = photo?.attribution;
    const isSelected = photoIndex === selectedMediaIndex;
    return (
      <View className="flex-1">
        <CustomImageZoom
          uri={uri}
          resetKey={uri}
          setZooming={setZooming}
          selectedMediaIndex={selectedMediaIndex}
          autoDetectSubject={autoDetectSubject}
          // Pinching here logs the framing, so reopening or paging back to this
          // photo shows it framed the way the user left it.
          restoreFramedCrop
          detectUri={uri}
          brightness={isSelected
            ? brightness
            : BRIGHTNESS_DEFAULT}
          zoomRef={( ref: SharedZoomableImageRef | null ) => {
            if ( photoIndex === selectedMediaIndex ) {
              currentZoomRefRef.current = ref;
            }
          }}
          onSwipeToClose={onClose}
          onImageDimensionsChange={handleImageDimensionsChange}
          onInteractionEnd={handleInteractionEnd}
          onScaleChange={isSelected
            ? handleScaleChange
            : undefined}
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
                    optionalClasses="mr-2"
                  />
                ) }
                { onSharePhoto && (
                  <TransparentCircleButton
                    onPress={( ) => onSharePhoto( uri )}
                    icon="share"
                    accessibilityLabel={t( "Share" )}
                    testID="MediaViewer.shareButton"
                  />
                ) }
              </View>
            )
        }
        { editable && onSharePhoto && (
          <View className="absolute bottom-4 left-4">
            <INatIconButton
              onPress={( ) => onSharePhoto( uri )}
              icon="share"
              color={colors.white}
              className={iconBtnClass}
              accessibilityLabel={t( "Share" )}
              testID="MediaViewer.shareButton"
              size={20}
            />
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
      {/* Zoom + brightness sliders below the photo, matching the crop editor */}
      <View className="py-1">
        <ZoomBrightnessSliders
          disabled={!selectedPhoto}
          zoomScale={zoomScale}
          brightnessStops={brightnessStops}
          exposureStopsMin={EXPOSURE_STOPS_MIN}
          exposureStopsMax={EXPOSURE_STOPS_MAX}
          onZoomChange={handleZoomChange}
          onZoomComplete={handleInteractionEnd}
          onBrightnessChange={handleBrightnessChange}
          onBrightnessComplete={handleBrightnessComplete}
          zoomAccessibilityLabel={t( "Adjust-zoom" )}
          brightnessAccessibilityLabel={t( "Adjust-brightness" )}
          iconColor={colors.white}
        />
      </View>
    </View>
  );
};

export default MainMediaDisplay;
