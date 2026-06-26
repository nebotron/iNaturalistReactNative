import Slider from "@react-native-community/slider";
import SoundContainer from "components/ObsDetailsSharedComponents/Media/SoundContainer";
import {
  INatIconButton,
  TransparentCircleButton,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, {
  useCallback, useEffect, useMemo, useState,
} from "react";
import { ActivityIndicator } from "react-native";
import type { PanGesture } from "react-native-gesture-handler";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import type { CarouselRenderItem, ICarouselInstance } from "react-native-reanimated-carousel";
import Carousel from "react-native-reanimated-carousel";
import Photo from "realmModels/Photo";
import { saveBrightness } from "sharedHelpers/brightnessLog";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import { openExternalWebBrowser } from "sharedHelpers/util";
import useDeviceOrientation from "sharedHooks/useDeviceOrientation";
import useTranslation from "sharedHooks/useTranslation";
import colors from "styles/tailwindColors";

import AttributionButton from "./AttributionButton";
import CustomImageZoom from "./CustomImageZoom";

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

const BRIGHTNESS_MIN = 0.1;
const BRIGHTNESS_MAX = 3.0;
const BRIGHTNESS_DEFAULT = 1.0;
const sliderStyle = { flex: 1, height: 40 };

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
  const { screenWidth } = useDeviceOrientation( );
  const [zooming, setZooming] = useState( false );
  const [brightness, setBrightness] = useState( BRIGHTNESS_DEFAULT );
  const [brightnessSaved, setBrightnessSaved] = useState( false );
  const [brightnessSaving, setBrightnessSaving] = useState( false );
  const [showBrightnessSlider, setShowBrightnessSlider] = useState( false );
  const items = useMemo( ( ) => ( [
    ...photos.map( photo => ( { ...photo, type: "photo" as const } ) ),
    ...sounds.map( sound => ( { ...sound, type: "sound" as const } ) ),
  ] ), [photos, sounds] );

  // On the render right after a photo is removed, selectedMediaIndex can still
  // point at the deleted index
  const safeDefaultIndex = Math.max(
    0,
    Math.min( selectedMediaIndex, items.length - 1 ),
  );

  const deletePhotoLabel = t( "Delete-photo" );
  const deleteSoundLabel = t( "Delete-sound" );
  const cropPhotoLabel = t( "CROP-PHOTO" );

  // Resolve each photo's large URI to a local file once so both the viewer
  // and the crop editor share the same single download.
  const [localUris, setLocalUris] = useState<Record<string, string>>( {} );
  useEffect( ( ) => {
    let cancelled = false;
    photos.forEach( photo => {
      const remoteUri = Photo.displayLocalOrRemoteLargePhoto( photo );
      if ( !remoteUri ) return;
      ensureLocalImageForCrop( remoteUri ).then( localUri => {
        if ( !cancelled ) {
          setLocalUris( prev => ( { ...prev, [remoteUri]: localUri } ) );
        }
      } ).catch( ( ) => { /* show nothing until retry */ } );
    } );
    return ( ) => { cancelled = true; };
  }, [photos] );

  const renderPhoto = ( photo: PhotoItem ) => {
    const remoteUri = Photo.displayLocalOrRemoteLargePhoto( photo );
    const localUri = remoteUri ? localUris[remoteUri] : undefined;
    const hasAttribution = photo?.attribution;
    return (
      <View className="flex-1">
        { localUri
          ? (
            <CustomImageZoom
              uri={localUri}
              resetKey={localUri}
              setZooming={setZooming}
              selectedMediaIndex={selectedMediaIndex}
              brightness={brightness}
              onLongPress={onLongPressPhoto
                ? ( ) => onLongPressPhoto( localUri )
                : undefined}
            />
          )
          : (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator color={colors.white} />
            </View>
          ) }
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
              <Slider
                style={sliderStyle}
                minimumValue={BRIGHTNESS_MIN}
                maximumValue={BRIGHTNESS_MAX}
                minimumTrackTintColor={colors.inatGreen}
                maximumTrackTintColor={colors.white}
                thumbTintColor={colors.white}
                value={brightness}
                onValueChange={val => { setBrightness( val ); setBrightnessSaved( false ); }}
                tapToSeek
                accessibilityLabel={t( "Adjust-brightness" )}
              />
              { brightness !== BRIGHTNESS_DEFAULT && (
                <>
                  { brightnessSaving
                    ? (
                      <View className="bg-black/50 items-center justify-center rounded-full h-[40px] w-[40px] ml-2">
                        <ActivityIndicator
                          size="small"
                          color={colors.white}
                        />
                      </View>
                    )
                    : (
                      <INatIconButton
                        className="bg-black/50 items-center justify-center rounded-full h-[40px] w-[40px] ml-2"
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
                    onPress={( ) => setBrightness( BRIGHTNESS_DEFAULT )}
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

  const renderSound = ( sound: SoundItem ) => (
    <View
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
  );

  const renderItem: CarouselRenderItem<PhotoItem | SoundItem> = ( { item } ) => (
    item.type === "photo"
      ? renderPhoto( item )
      : renderSound( item )
  );

  // Must be stable: onConfigurePanGesture is a useMemo dependency inside the Carousel
  const onConfigurePanGesture = useCallback( ( panGesture: PanGesture ) => {
    panGesture
      // Page only on clearly horizontal drags; leave vertical intent as swipe-to-close
      .activeOffsetX( [-10, 10] )
      .failOffsetY( [-15, 15] )
      // A second finger means pinch-to-zoom do not pan
      .maxPointers( 1 );
  }, [] );

  const swipeToCloseGesture = Gesture.Pan()
    .runOnJS( true )
    // While zoomed, a downward drag should pan the image, not close the viewer
    .enabled( !zooming )
    .maxPointers( 1 )
    // Activate only on a mostly-vertical downward drag
    .activeOffsetY( 15 )
    .failOffsetX( [-15, 15] )
    .onUpdate( ( { translationY, velocityY } ) => {
      if ( translationY > 50 && velocityY > 500 ) {
        // Close media viewer on swipe down
        onClose();
      }
    } );

  return (
    <View className="flex-1">
      <GestureHandlerRootView>
        <GestureDetector gesture={swipeToCloseGesture}>
          <View collapsable={false}>
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
          </View>
        </GestureDetector>
      </GestureHandlerRootView>
    </View>
  );
};

export default MainMediaDisplay;
