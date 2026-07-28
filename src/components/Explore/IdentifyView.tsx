import { useNavigation } from "@react-navigation/native";
import { createIdentification } from "api/identifications";
import { markAsReviewed } from "api/observations";
import type { ApiObservation, ApiObservationsSearchParams } from "api/types";
import useInfiniteExploreScroll from "components/Explore/hooks/useInfiniteExploreScroll";
import type { IdentifyPhotoHandle } from "components/MediaViewer/IdentifyPhoto";
import {
  clampZoom,
  IdentifyPhoto,
  MIN_ZOOM,
  ZoomBrightnessSliders,
  zoomPosToScale,
} from "components/MediaViewer/IdentifyPhoto";
import useTopSpeciesSuggestion
  from "components/ObservationsFlashList/hooks/useTopSpeciesSuggestion";
import {
  ActivityIndicator,
  Body2,
  Button,
  INatIcon,
  INatIconButton,
} from "components/SharedComponents";
import DisplayTaxonName from "components/SharedComponents/DisplayTaxonName";
import { Pressable, View } from "components/styledComponents";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Dimensions, Image, StyleSheet } from "react-native";
import Photo from "realmModels/Photo";
import { preloadSubjectDetectionForUri } from "sharedHelpers/useSubjectDetectionForUri";
import {
  useAuthenticatedMutation,
  useCurrentUser,
  useIdentifyPhotoBrightness,
  useTranslation,
} from "sharedHooks";
import {
  EXPOSURE_STOPS_MAX,
  EXPOSURE_STOPS_MIN,
} from "sharedHooks/useIdentifyPhotoBrightness";
import colors from "styles/tailwindColors";

// Fetch the next page once we're within this many observations of the end.
const PREFETCH_THRESHOLD = 5;

const styles = StyleSheet.create( {
  container: { paddingTop: 30 },
  buttonRow: { height: 60 },
} );

const photosForObs = ( obs?: ApiObservation ): string[] => (
  ( obs?.observation_photos ?? [] )
    .map( op => Photo.displayLargePhoto( op?.photo?.url ) )
    .filter( ( url ): url is string => !!url )
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
  const photoRef = useRef<IdentifyPhotoHandle | null>( null );

  const {
    observations,
    totalResults,
    fetchNextPage,
    isLoading,
  } = useInfiniteExploreScroll( { params: queryParams, enabled: !!canFetch } );

  const [currentIndex, setCurrentIndex] = useState( 0 );
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState( 0 );
  const [zoomScale, setZoomScale] = useState( MIN_ZOOM );

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
  const {
    brightness, brightnessStops, setBrightnessStops, handleBrightnessComplete,
  } = useIdentifyPhotoBrightness( currentPhotoUrl );

  // Update the exposure override live; the image re-renders with the new
  // brightness filter each tick.
  const handleBrightnessChange = useCallback( ( value: number ) => {
    setBrightnessStops( value );
  }, [setBrightnessStops] );

  // Reset to the first photo whenever the observation changes.
  useEffect( ( ) => {
    setSelectedPhotoIndex( 0 );
  }, [observationUuid] );

  // Reset zoom for the visible photo (brightness resets itself via
  // useIdentifyPhotoBrightness).
  useEffect( ( ) => {
    setZoomScale( MIN_ZOOM );
  }, [currentPhotoUrl] );

  // Warm the image cache and subject detection for the current observation's
  // other photos and the first photo of upcoming observations, so advancing or
  // paging shows them with no download/detection delay.
  useEffect( ( ) => {
    const upcoming = observations
      .slice( currentIndex + 1, currentIndex + 1 + PREFETCH_THRESHOLD )
      .map( obs => photosForObs( obs )[0] )
      .filter( ( url ): url is string => !!url );
    [...photoUrls, ...upcoming].forEach( url => {
      Image.prefetch( url ).catch( ( ) => undefined );
      preloadSubjectDetectionForUri( url );
    } );
    // observations' array identity changes every render; key off stable signals
    // so we don't re-prefetch on every re-render (e.g. during a pinch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observationUuid, currentIndex, observations.length] );

  const goToNext = useCallback( ( ) => {
    setCurrentIndex( prev => {
      const next = prev + 1;
      if ( next >= observations.length - PREFETCH_THRESHOLD ) fetchNextPage( );
      return next;
    } );
  }, [fetchNextPage, observations.length] );

  const goToPhoto = useCallback( ( delta: number ) => {
    setSelectedPhotoIndex( prev => Math.min(
      photoUrls.length - 1,
      Math.max( 0, prev + delta ),
    ) );
  }, [photoUrls.length] );

  const openObsDetails = useCallback( ( ) => {
    if ( !observationUuid ) return;
    navigation.navigate( {
      key: `Obs-ExploreIdentify-${observationUuid}`,
      name: "ObsDetails",
      params: { uuid: observationUuid, preloadedObservation: observation },
    } as never );
  }, [navigation, observation, observationUuid] );

  // If the community taxon is genus or broader, suggest the most likely
  // species-level CV taxon instead of the coarser community taxon. Score the
  // currently displayed photo through the same pipeline as the Suggest ID
  // screen so the suggestion matches it.
  const topSpeciesSuggestion = useTopSpeciesSuggestion( observation, currentPhotoUrl );
  const taxon = topSpeciesSuggestion || observation?.taxon;

  const openTaxonDetails = useCallback( ( ) => {
    const id = taxon?.id;
    if ( !id ) return;
    navigation.navigate( "TaxonDetails" as never, { id } as never );
  }, [navigation, taxon?.id] );

  // Keep the zoom slider in sync with pinch/double-tap/subject-framing zoom.
  const handleScaleChange = useCallback(
    ( scale: number ) => setZoomScale( clampZoom( scale ) ),
    [],
  );

  const handleZoomChange = useCallback( ( pos: number ) => {
    const scale = zoomPosToScale( pos );
    setZoomScale( scale );
    photoRef.current?.applyZoom( scale );
  }, [] );

  const { mutate: agreeMutate } = useAuthenticatedMutation(
    ( params, optsWithAuth ) => createIdentification( params, optsWithAuth ),
  );
  const { mutate: reviewMutate } = useAuthenticatedMutation(
    ( params, optsWithAuth ) => markAsReviewed( params, optsWithAuth ),
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

  const isOwnObs = observation.user?.id != null && observation.user.id === currentUser?.id;
  const agreeDisabled = !currentUser || !taxon?.id || isOwnObs;
  const reviewDisabled = !currentUser;

  const handleAgree = ( ) => {
    if ( !observationUuid || !taxon?.id ) return;
    agreeMutate( {
      identification: { observation_id: observationUuid, taxon_id: taxon.id },
    } );
    goToNext( );
  };
  const handleReview = ( ) => {
    if ( !observationUuid ) return;
    reviewMutate( { uuid: observationUuid } );
    goToNext( );
  };

  return (
    <View className="flex-1" style={styles.container}>
      {/* Square, zoomable/pannable image with subject detection. Nothing is
          drawn over the image; tapping it opens the full observation. */}
      <View
        // We need these dynamic dimensions to keep the image square
        // eslint-disable-next-line react-native/no-inline-styles
        style={{ width: windowWidth, height: windowWidth }}
        // No background of its own: any letterboxing around a non-square photo
        // then shows the screen background, so the padding and the rest of the
        // screen are the same color.
        className="overflow-hidden"
      >
        {currentPhotoUrl
          ? (
            <IdentifyPhoto
              // Remount per photo so each frames to its own subject.
              key={currentPhotoUrl}
              ref={photoRef}
              uri={currentPhotoUrl}
              size={windowWidth}
              brightness={brightness}
              onSingleTap={openObsDetails}
              onScaleChange={handleScaleChange}
            />
          )
          : (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator />
            </View>
          )}
      </View>

      {/* Left / right photo navigation (below the image). Always rendered,
          even for a single photo, so the layout doesn't shift by photo count;
          the chevrons are simply disabled when there's nothing to page to. */}
      <View className="flex-row items-center justify-center pt-1">
        <INatIconButton
          icon="chevron-left-circle"
          size={30}
          color={colors.inatGreen}
          disabled={selectedPhotoIndex === 0}
          accessibilityLabel={t( "Previous-slide" )}
          onPress={( ) => goToPhoto( -1 )}
          testID="IdentifyView.prevPhoto"
        />
        <Body2 className="mx-4">
          {`${selectedPhotoIndex + 1}/${photoUrls.length}`}
        </Body2>
        <INatIconButton
          icon="chevron-right-circle"
          size={30}
          color={colors.inatGreen}
          disabled={selectedPhotoIndex === photoUrls.length - 1}
          accessibilityLabel={t( "Next-slide" )}
          onPress={( ) => goToPhoto( 1 )}
          testID="IdentifyView.nextPhoto"
        />
      </View>

      {/* Zoom + brightness sliders (below the image, not covering it) */}
      <ZoomBrightnessSliders
        zoomScale={zoomScale}
        brightnessStops={brightnessStops}
        exposureStopsMin={EXPOSURE_STOPS_MIN}
        exposureStopsMax={EXPOSURE_STOPS_MAX}
        onZoomChange={handleZoomChange}
        onZoomComplete={( ) => photoRef.current?.saveCrop( )}
        onBrightnessChange={handleBrightnessChange}
        onBrightnessComplete={handleBrightnessComplete}
        zoomAccessibilityLabel={t( "Adjust-zoom" )}
        brightnessAccessibilityLabel={t( "Adjust-brightness" )}
      />

      {/* Agree / Mark reviewed / Next — three equal buttons */}
      <View className="flex-row px-4 gap-2" style={styles.buttonRow}>
        <View className="flex-1">
          <Button
            className="w-full h-full"
            text={t( "Agree" )}
            level="focus"
            disabled={agreeDisabled}
            onPress={handleAgree}
            testID="IdentifyView.agree"
          />
        </View>
        <View className="flex-1">
          <Button
            className="w-full h-full"
            text={t( "Reviewed" )}
            disabled={reviewDisabled}
            onPress={handleReview}
            testID="IdentifyView.review"
          />
        </View>
        <View className="flex-1">
          <Button
            className="w-full h-full"
            text={t( "Next" )}
            onPress={goToNext}
            testID="IdentifyView.next"
          />
        </View>
      </View>

      {/* Current id'ed taxon — common name only, tap for species details */}
      <View className="px-4 py-2 items-center justify-center">
        {taxon
          ? (
            <Pressable
              className="flex-row items-center gap-x-2"
              accessibilityRole="button"
              accessibilityLabel={t( "View-taxon" )}
              onPress={openTaxonDetails}
            >
              {/* Flag taxa sourced from the CV detector rather than the
                  community, using the same sparkly icon used elsewhere. */}
              {topSpeciesSuggestion && (
                <INatIcon name="sparkly-label" size={18} />
              )}
              <DisplayTaxonName taxon={taxon} showOneNameOnly />
            </Pressable>
          )
          : (
            <Body2>{t( "Unknown--taxon" )}</Body2>
          )}
      </View>
    </View>
  );
};

export default IdentifyView;
