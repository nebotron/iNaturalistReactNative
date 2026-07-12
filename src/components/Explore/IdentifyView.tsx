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
  useCallback, useEffect, useRef, useState,
} from "react";
import { Dimensions, StyleSheet } from "react-native";
import Photo from "realmModels/Photo";
import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
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

const photoUriForObs = ( obs?: ApiObservation ): string | undefined => (
  Photo.displayLargePhoto( obs?.observation_photos?.[0]?.photo?.url )
);

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
  const [brightnessStops, setBrightnessStops] = useState( EXPOSURE_STOPS_DEFAULT );
  const [showBrightnessSlider, setShowBrightnessSlider] = useState( false );
  const brightness = stopsToGain( brightnessStops );

  const imageRef = useRef<SharedZoomableImageRef | null>( null );

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
  const photoUri = photoUriForObs( observation );

  const detection = useSubjectDetectionForUri( photoUri );

  // Reset zoom to the full image when the photo changes.
  useEffect( ( ) => {
    imageRef.current?.applyTransform( IDENTITY_TRANSFORM );
  }, [photoUri] );

  // Zoom to the detected subject once detection resolves for the current photo.
  useEffect( ( ) => {
    if ( !detection || !imageRef.current ) return;
    imageRef.current.applyTransform( cropToZoomTransform(
      detection.crop,
      windowWidth,
      detection.imageWidth,
      detection.imageHeight,
    ) );
  }, [detection, windowWidth] );

  // Preload subject detection for the next few observations so they appear
  // already cropped to the subject.
  useEffect( ( ) => {
    observations
      .slice( currentIndex + 1, currentIndex + 1 + PREFETCH_THRESHOLD )
      .forEach( obs => {
        const url = photoUriForObs( obs );
        if ( url ) preloadSubjectDetectionForUri( url );
      } );
  }, [observations, currentIndex] );

  const goToNext = useCallback( ( ) => {
    setBrightnessStops( EXPOSURE_STOPS_DEFAULT );
    setCurrentIndex( prev => {
      const next = prev + 1;
      if ( next >= observations.length - PREFETCH_THRESHOLD ) fetchNextPage( );
      return next;
    } );
  }, [fetchNextPage, observations.length] );

  const openObsDetails = useCallback( ( ) => {
    if ( !observation?.uuid ) return;
    navigation.navigate( {
      key: `Obs-ExploreIdentify-${observation.uuid}`,
      name: "ObsDetails",
      params: { uuid: observation.uuid, preloadedObservation: observation },
    } as never );
  }, [navigation, observation] );

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
      {/* Square, zoomable, pannable image with subject detection. Tapping opens
          the full observation. */}
      <View
        // We need these dynamic dimensions to keep the image square
        // eslint-disable-next-line react-native/no-inline-styles
        style={{ width: windowWidth, height: windowWidth }}
        className="bg-black overflow-hidden"
      >
        {photoUri
          ? (
            <SharedZoomableImage
              ref={imageRef}
              uri={photoUri}
              style={styles.image}
              brightness={brightness}
              maxScale={100}
              isDoubleTapEnabled
              onSingleTap={openObsDetails}
              testID="IdentifyView.image"
            />
          )
          : (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator />
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
