import Slider from "@react-native-community/slider";
import { useNavigation } from "@react-navigation/native";
import type { ApiObservation, ApiObservationsSearchParams } from "api/types";
import useInfiniteExploreScroll from "components/Explore/hooks/useInfiniteExploreScroll";
import type { SharedZoomableImageRef } from "components/MediaViewer/SharedZoomableImage";
import SharedZoomableImage from "components/MediaViewer/SharedZoomableImage";
import AgreeButton from "components/ObsDetails/AgreeButton";
import ReviewButton from "components/ObsDetails/ReviewButton";
import {
  ActivityIndicator,
  Body2,
  Button,
  INatIconButton,
} from "components/SharedComponents";
import DisplayTaxonName from "components/SharedComponents/DisplayTaxonName";
import { View } from "components/styledComponents";
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { Dimensions, StyleSheet } from "react-native";
import type { PanGesture } from "react-native-gesture-handler";
import type { CarouselRenderItem } from "react-native-reanimated-carousel";
import Carousel from "react-native-reanimated-carousel";
import Photo from "realmModels/Photo";
import { saveAnimalCrop } from "sharedHelpers/animalCropLog";
import { getBrightness, saveBrightness } from "sharedHelpers/brightnessLog";
import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { computeContainRect } from "sharedHelpers/normalizedCropTypes";
import useSubjectDetectionForUri, {
  preloadSubjectDetectionForUri,
} from "sharedHelpers/useSubjectDetectionForUri";
import { useCurrentUser, useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

const MAX_ZOOM_SCALE = 5;
// Exposure slider in stops (EV); the gain applied to the image is 2^stops.
const EXPOSURE_STOPS_MIN = -1;
const EXPOSURE_STOPS_MAX = 4;
const EXPOSURE_STOPS_DEFAULT = 0;
const stopsToGain = ( stops: number ) => 2 ** stops;
const gainToStops = ( gain: number ) => Math.min(
  EXPOSURE_STOPS_MAX,
  Math.max( EXPOSURE_STOPS_MIN, Math.log2( gain ) ),
);
// Fetch the next page once we're within this many observations of the end.
const PREFETCH_THRESHOLD = 5;

const IDENTITY_TRANSFORM: ImageZoomTransform = {
  scale: 1, translateX: 0, translateY: 0, focalX: 0, focalY: 0,
};

const styles = StyleSheet.create( {
  image: { flex: 1 },
  slider: { flex: 1, height: 40 },
  container: { paddingTop: 45 },
} );

// Convert a normalized subject-detection crop into an image-zoom transform that
// frames the subject within a square viewport (mirrors the SpeciesGame logic).
const cropToZoomTransform = (
  crop: NormalizedCrop,
  viewportSize: number,
  imageWidth: number,
  imageHeight: number,
): ImageZoomTransform => {
  const contain = computeContainRect( viewportSize, viewportSize, imageWidth, imageHeight );
  if ( contain.width <= 0 || contain.height <= 0 ) return IDENTITY_TRANSFORM;
  const center = viewportSize / 2;
  const cx = contain.left + ( crop.x + crop.w / 2 ) * contain.width;
  const cy = contain.top + ( crop.y + crop.h / 2 ) * contain.height;
  const scale = Math.min(
    MAX_ZOOM_SCALE,
    Math.max( 1, Math.min(
      viewportSize / ( crop.w * contain.width ),
      viewportSize / ( crop.h * contain.height ),
    ) ),
  );
  return {
    scale,
    translateX: 0,
    translateY: 0,
    focalX: ( center - cx ) * scale,
    focalY: ( center - cy ) * scale,
  };
};

const photosForObs = ( obs?: ApiObservation ): string[] => (
  ( obs?.observation_photos ?? [] )
    .map( op => Photo.displayLargePhoto( op?.photo?.url ) )
    .filter( ( url ): url is string => !!url )
);

interface IdentifyPhotoProps {
  uri: string;
  size: number;
  brightness: number;
  onSingleTap: ( ) => void;
}

// A single swipeable, subject-framed photo. Two-finger gestures pan/zoom (one
// finger is left free so the carousel can page); the framed viewport is saved
// to the crop log (which syncs to Firebase) whenever a gesture ends.
const IdentifyPhoto = ( {
  uri,
  size,
  brightness,
  onSingleTap,
}: IdentifyPhotoProps ) => {
  const imageRef = useRef<SharedZoomableImageRef | null>( null );
  const dimsRef = useRef<{ width: number; height: number } | null>( null );
  const appliedRef = useRef( false );
  const detection = useSubjectDetectionForUri( uri );

  // When a recycled carousel slot receives a new photo, clear the previous
  // framing so the new photo re-frames to its own subject.
  useEffect( ( ) => {
    appliedRef.current = false;
    imageRef.current?.applyTransform( IDENTITY_TRANSFORM );
  }, [uri] );

  // Frame the detected (or previously logged) subject once detection resolves.
  useEffect( ( ) => {
    if ( appliedRef.current || !detection || !imageRef.current ) return;
    imageRef.current.applyTransform( cropToZoomTransform(
      detection.crop,
      size,
      detection.imageWidth,
      detection.imageHeight,
    ) );
    appliedRef.current = true;
  }, [detection, size] );

  const handleInteractionEnd = useCallback( ( ) => {
    // Let the gesture's settling animation finish before reading the transform.
    setTimeout( ( ) => {
      const dims = dimsRef.current;
      if ( !imageRef.current || !dims ) return;
      const crop = imageZoomTransformToNormalizedCrop(
        dims.width,
        dims.height,
        size,
        size,
        size,
        imageRef.current.readTransform( ),
      );
      saveAnimalCrop( uri, crop );
    }, 400 );
  }, [size, uri] );

  return (
    <SharedZoomableImage
      ref={imageRef}
      uri={uri}
      style={styles.image}
      brightness={brightness}
      maxScale={100}
      isDoubleTapEnabled
      isSingleFingerPanEnabled={false}
      onSingleTap={onSingleTap}
      onInteractionEnd={handleInteractionEnd}
      onImageDimensionsChange={dims => { dimsRef.current = dims; }}
      testID="IdentifyView.image"
    />
  );
};

interface Props {
  canFetch?: boolean;
  queryParams: ApiObservationsSearchParams;
  handleUpdateCount: ( view: string, count: number | null ) => void;
}

const IdentifyView = ( {
  canFetch,
  queryParams,
  handleUpdateCount,
}: Props ) => {
  const { t } = useTranslation( );
  const navigation = useNavigation( );
  const currentUser = useCurrentUser( );
  const windowWidth = Dimensions.get( "window" ).width;

  const {
    observations,
    totalResults,
    fetchNextPage,
    isLoading,
  } = useInfiniteExploreScroll( { params: queryParams, enabled: !!canFetch } );

  const [currentIndex, setCurrentIndex] = useState( 0 );
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState( 0 );
  const [brightnessStops, setBrightnessStops] = useState( EXPOSURE_STOPS_DEFAULT );
  const [showBrightnessSlider, setShowBrightnessSlider] = useState( false );
  const brightness = stopsToGain( brightnessStops );

  useEffect( ( ) => {
    handleUpdateCount( "identify", totalResults );
  }, [handleUpdateCount, totalResults] );

  // Reset to the first observation whenever the filter (and thus the query)
  // changes. queryParams is a fresh object each parent render, so key the reset
  // on its serialized content rather than its identity.
  const queryKey = JSON.stringify( queryParams );
  useEffect( ( ) => {
    setCurrentIndex( 0 );
  }, [queryKey] );

  const observation = observations[currentIndex];
  const observationUuid = observation?.uuid;
  const photoUrls = useMemo(
    ( ) => photosForObs( observation ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [observationUuid],
  );
  const currentPhotoUrl = photoUrls[selectedPhotoIndex];

  // Reset to the first photo whenever the observation changes.
  useEffect( ( ) => {
    setSelectedPhotoIndex( 0 );
  }, [observationUuid] );

  // Load any previously-saved brightness for the visible photo so saved
  // adjustments round-trip.
  useEffect( ( ) => {
    const saved = currentPhotoUrl
      ? getBrightness( currentPhotoUrl )
      : null;
    setBrightnessStops( saved
      ? gainToStops( saved )
      : EXPOSURE_STOPS_DEFAULT );
  }, [currentPhotoUrl] );

  // Preload subject detection for the first photo of the next few observations.
  useEffect( ( ) => {
    observations
      .slice( currentIndex + 1, currentIndex + 1 + PREFETCH_THRESHOLD )
      .forEach( obs => {
        const url = photosForObs( obs )[0];
        if ( url ) preloadSubjectDetectionForUri( url );
      } );
  }, [observations, currentIndex] );

  const goToNext = useCallback( ( ) => {
    setCurrentIndex( prev => {
      const next = prev + 1;
      if ( next >= observations.length - PREFETCH_THRESHOLD ) fetchNextPage( );
      return next;
    } );
  }, [fetchNextPage, observations.length] );

  const openObsDetails = useCallback( ( ) => {
    if ( !observationUuid ) return;
    navigation.navigate( {
      key: `Obs-ExploreIdentify-${observationUuid}`,
      name: "ObsDetails",
      params: { uuid: observationUuid, preloadedObservation: observation },
    } as never );
  }, [navigation, observation, observationUuid] );

  const handleBrightnessComplete = useCallback( ( value: number ) => {
    setBrightnessStops( value );
    if ( currentPhotoUrl ) saveBrightness( currentPhotoUrl, stopsToGain( value ) );
  }, [currentPhotoUrl] );

  const renderPhoto = useCallback<CarouselRenderItem<string>>(
    ( { item, index } ) => (
      <IdentifyPhoto
        uri={item}
        size={windowWidth}
        brightness={index === selectedPhotoIndex
          ? brightness
          : 1}
        onSingleTap={openObsDetails}
      />
    ),
    [brightness, openObsDetails, selectedPhotoIndex, windowWidth],
  );

  if ( isLoading && observations.length === 0 ) {
    return (
      <View className="flex-1 items-center justify-center" style={styles.container}>
        <ActivityIndicator size={40} />
      </View>
    );
  }

  if ( !observation ) {
    return (
      <View className="flex-1 items-center justify-center p-4" style={styles.container}>
        <Body2 className="text-center">{t( "No-results-found" )}</Body2>
      </View>
    );
  }

  const taxon = observation.taxon;

  return (
    <View className="flex-1" style={styles.container}>
      {/* Square, swipeable, zoomable image carousel with subject detection.
          Tapping opens the full observation. */}
      <View
        // We need these dynamic dimensions to keep the image square
        // eslint-disable-next-line react-native/no-inline-styles
        style={{ width: windowWidth, height: windowWidth }}
        className="bg-black overflow-hidden"
      >
        {photoUrls.length > 0
          ? (
            <Carousel
              // Remount per observation so paging resets to the first photo.
              key={observationUuid}
              data={photoUrls}
              renderItem={renderPhoto}
              width={windowWidth}
              height={windowWidth}
              loop={false}
              onSnapToItem={setSelectedPhotoIndex}
              onConfigurePanGesture={( panGesture: PanGesture ) => {
                // Page only on clearly horizontal single-finger drags, leaving
                // two-finger gestures for the image's own pan/zoom.
                panGesture
                  .activeOffsetX( [-10, 10] )
                  .failOffsetY( [-15, 15] )
                  .maxPointers( 1 );
              }}
              testID="IdentifyView.carousel"
            />
          )
          : (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator />
            </View>
          )}

        {/* Photo counter */}
        {photoUrls.length > 1 && (
          <View className="absolute top-3 right-3 bg-black/50 rounded-full px-3 py-1">
            <Body2 className="text-white">
              {`${selectedPhotoIndex + 1}/${photoUrls.length}`}
            </Body2>
          </View>
        )}

        {/* Brightness toggle + slider overlaid on the image */}
        <View className="absolute bottom-3 left-3">
          <INatIconButton
            icon="sliders"
            size={20}
            color={showBrightnessSlider || brightness !== 1
              ? colors.inatGreen
              : colors.white}
            className="bg-black/50 items-center justify-center rounded-full h-[40px] w-[40px]"
            accessibilityLabel={t( "Adjust-brightness" )}
            onPress={( ) => setShowBrightnessSlider( ( prev: boolean ) => !prev )}
          />
        </View>
        {showBrightnessSlider && (
          <View className="absolute bottom-16 left-3 right-3">
            <View className="bg-black/60 rounded-xl px-3 flex-row items-center">
              <Slider
                style={styles.slider}
                minimumValue={EXPOSURE_STOPS_MIN}
                maximumValue={EXPOSURE_STOPS_MAX}
                minimumTrackTintColor={colors.inatGreen}
                maximumTrackTintColor={colors.white}
                thumbTintColor={colors.white}
                value={brightnessStops}
                onValueChange={setBrightnessStops}
                onSlidingComplete={handleBrightnessComplete}
                tapToSeek
                accessibilityLabel={t( "Adjust-brightness" )}
              />
            </View>
          </View>
        )}
      </View>

      {/* Current id'ed taxon */}
      <View className="px-4 py-3 items-center justify-center">
        {taxon
          ? (
            <DisplayTaxonName taxon={taxon} />
          )
          : (
            <Body2>{t( "Unknown--taxon" )}</Body2>
          )}
      </View>

      {/* Agree and mark-reviewed actions */}
      {currentUser && (
        <View className="flex-row items-center justify-center px-4 gap-x-10">
          <View className="items-center">
            <AgreeButton
              observation={observation}
              currentUser={currentUser}
              directAgree
              positionClassName=""
              afterAgree={goToNext}
            />
            <Body2 className="mt-1">{t( "Agree" )}</Body2>
          </View>
          <View className="items-center">
            <ReviewButton
              observation={observation}
              currentUser={currentUser}
              positionClassName=""
              afterToggleReview={goToNext}
            />
            <Body2 className="mt-1">{t( "Mark-as-reviewed" )}</Body2>
          </View>
        </View>
      )}

      {/* Go to next without marking reviewed */}
      <View className="px-4 pt-3">
        <Button
          text={t( "Next-observation" )}
          onPress={goToNext}
          accessibilityLabel={t( "Next-observation" )}
          testID="IdentifyView.next"
        />
      </View>
    </View>
  );
};

export default IdentifyView;
