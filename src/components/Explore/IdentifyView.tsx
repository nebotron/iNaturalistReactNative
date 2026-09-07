import { prefetch } from "@candlefinance/faster-image";
import { useNavigation } from "@react-navigation/native";
import { createIdentification } from "api/identifications";
import { markAsReviewed } from "api/observations";
import type { ApiObservation, ApiObservationsSearchParams } from "api/types";
import classnames from "classnames";
import useInfiniteExploreScroll from "components/Explore/hooks/useInfiniteExploreScroll";
import type { IdentifyPhotoHandle } from "components/MediaViewer/IdentifyPhoto";
import {
  IdentifyPhoto,
  ZoomBrightnessSliders,
} from "components/MediaViewer/IdentifyPhoto";
import SoundContainer from "components/ObsDetailsSharedComponents/Media/SoundContainer";
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
import { Dimensions, StyleSheet } from "react-native";
import Photo from "realmModels/Photo";
import { preloadSubjectDetectionForUri } from "sharedHelpers/useSubjectDetectionForUri";
import {
  useAuthenticatedMutation,
  useCurrentUser,
  useTranslation,
} from "sharedHooks";
import {
  EXPOSURE_STOPS_MAX,
  EXPOSURE_STOPS_MIN,
} from "sharedHooks/useIdentifyPhotoBrightness";
import useIdentifyPhotoControls from "sharedHooks/useIdentifyPhotoControls";
import colors from "styles/tailwindColors";

// Fetch the next page once we're within this many observations of the end.
const PAGINATION_THRESHOLD = 5;

// How many observations ahead to start downloading photos for. Photos are
// shown at full original resolution, so we start these downloads well before
// the user reaches them to hide the latency.
const PHOTO_PREFETCH_LOOKAHEAD = 15;

// How long after the photo renders before the taxon name appears, so the name
// never beats the image it describes onto the screen.
const TAXON_DELAY_MS = 100;

const styles = StyleSheet.create( {
  container: { paddingTop: 30 },
  buttonRow: { height: 60 },
} );

// A sound we can actually play: the API type has file_url optional.
interface PlayableSound {
  file_url: string;
  hidden?: boolean;
}

const photosForObs = ( obs?: ApiObservation ): string[] => (
  ( obs?.observation_photos ?? [] )
    .map( op => Photo.displayOriginalPhoto( op?.photo?.url ) )
    .filter( ( url ): url is string => !!url )
);

const soundsForObs = ( obs?: ApiObservation ): PlayableSound[] => (
  ( obs?.observation_sounds ?? [] )
    .map( os => os?.sound )
    .filter( ( sound ): sound is PlayableSound => !!sound?.file_url )
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
  const [selectedMediaIndex, setSelectedMediaIndex] = useState( 0 );

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
  const sounds = useMemo(
    ( ) => soundsForObs( observation ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [observationUuid],
  );
  // Photos are what this view is built around, but an observation can have only
  // sounds, or no evidence at all. When there are no photos we page through the
  // sounds instead, so the counter and the chevrons stay meaningful.
  const mediaCount = photoUrls.length > 0
    ? photoUrls.length
    : sounds.length;
  const currentPhotoUrl = photoUrls[selectedMediaIndex];
  const currentSound = photoUrls.length === 0
    ? sounds[selectedMediaIndex]
    : undefined;
  const {
    brightness,
    brightnessStops,
    handleBrightnessChange,
    handleBrightnessComplete,
    handleScaleChange,
    handleZoomChange,
    zoomScale,
  } = useIdentifyPhotoControls( {
    brightnessKey: currentPhotoUrl,
    applyZoom: scale => photoRef.current?.applyZoom( scale ),
  } );

  // Reset to the first photo (or sound) whenever the observation changes.
  useEffect( ( ) => {
    setSelectedMediaIndex( 0 );
  }, [observationUuid] );

  // Warm the image cache and subject detection for the current observation's
  // other photos and the first photo of upcoming observations, so advancing or
  // paging shows them with no download/detection delay.
  useEffect( ( ) => {
    const upcoming = observations
      .slice( currentIndex + 1, currentIndex + 1 + PHOTO_PREFETCH_LOOKAHEAD )
      .map( obs => photosForObs( obs )[0] )
      .filter( ( url ): url is string => !!url );
    const urls = [...photoUrls, ...upcoming];
    // faster-image's prefetch, not React Native's: the photos are drawn by
    // FasterImageView, which reads Nuke's disk cache. Image.prefetch fills
    // React Native's own image cache instead, which that view never consults,
    // so the lookahead left every photo to download when it came on screen.
    prefetch( urls );
    urls.forEach( preloadSubjectDetectionForUri );
    // observations' array identity changes every render; key off stable signals
    // so we don't re-prefetch on every re-render (e.g. during a pinch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observationUuid, currentIndex, observations.length] );

  const goToNext = useCallback( ( ) => {
    setCurrentIndex( prev => {
      const next = prev + 1;
      if ( next >= observations.length - PAGINATION_THRESHOLD ) fetchNextPage( );
      return next;
    } );
  }, [fetchNextPage, observations.length] );

  const goToMedia = useCallback( ( delta: number ) => {
    setSelectedMediaIndex( prev => Math.min(
      mediaCount - 1,
      Math.max( 0, prev + delta ),
    ) );
  }, [mediaCount] );

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

  // Hide the taxon while a new photo is loading, and for a beat after it
  // renders. Nothing to wait for when there's no photo (sound-only or no
  // evidence), so it shows right away.
  const [taxonShown, setTaxonShown] = useState( !currentPhotoUrl );
  const taxonTimer = useRef<ReturnType<typeof setTimeout> | null>( null );
  useEffect( ( ) => {
    if ( taxonTimer.current ) clearTimeout( taxonTimer.current );
    setTaxonShown( !currentPhotoUrl );
  }, [currentPhotoUrl] );
  const handlePhotoLoad = useCallback( ( ) => {
    if ( taxonTimer.current ) clearTimeout( taxonTimer.current );
    taxonTimer.current = setTimeout( ( ) => setTaxonShown( true ), TAXON_DELAY_MS );
  }, [] );
  useEffect( ( ) => ( ) => {
    if ( taxonTimer.current ) clearTimeout( taxonTimer.current );
  }, [] );

  const openTaxonDetails = useCallback( ( ) => {
    const id = taxon?.id;
    if ( !id ) return;
    navigation.navigate( "TaxonDetails" as never, { id } as never );
  }, [navigation, taxon?.id] );

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

  // What fills the square media pane: the photo if there is one, otherwise the
  // sound, otherwise a "no evidence" marker. Sounds and the marker get a dark
  // background, matching how ObsDetails presents them (and SoundContainer's
  // controls are white).
  const renderMedia = ( ) => {
    if ( currentPhotoUrl ) {
      return (
        <IdentifyPhoto
          // Remount per photo so each frames to its own subject.
          key={currentPhotoUrl}
          ref={photoRef}
          uri={currentPhotoUrl}
          size={windowWidth}
          brightness={brightness}
          onSingleTap={openObsDetails}
          onScaleChange={handleScaleChange}
          onLoad={handlePhotoLoad}
          // Don't leave the taxon hidden forever if the photo never arrives.
          onError={handlePhotoLoad}
        />
      );
    }
    if ( currentSound ) {
      return (
        <View className="flex-1 bg-black justify-center">
          <SoundContainer
            key={currentSound.file_url}
            sizeClass="w-full"
            sound={currentSound}
            isVisible
          />
        </View>
      );
    }
    return (
      <Pressable
        className="flex-1 bg-black items-center justify-center"
        accessibilityRole="button"
        accessibilityLabel={t( "Observation-has-no-photos-and-no-sounds" )}
        // Same as tapping a photo: there's nothing to look at here, so let the
        // full observation be the way to judge it.
        onPress={openObsDetails}
        testID="IdentifyView.noEvidence"
      >
        <INatIcon name="noevidence" size={96} color={colors.white} />
      </Pressable>
    );
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
        {renderMedia( )}
      </View>

      {/* Left / right media navigation (below the image). Always rendered, even
          for a single photo, so the layout doesn't shift by media count; the
          chevrons are simply disabled when there's nothing to page to. */}
      <View className="flex-row items-center justify-center pt-1">
        <INatIconButton
          icon="chevron-left-circle"
          size={30}
          color={colors.inatGreen}
          disabled={selectedMediaIndex === 0}
          accessibilityLabel={t( "Previous-slide" )}
          onPress={( ) => goToMedia( -1 )}
          testID="IdentifyView.prevPhoto"
        />
        <Body2 className="mx-4">
          {`${Math.min( selectedMediaIndex + 1, mediaCount )}/${mediaCount}`}
        </Body2>
        <INatIconButton
          icon="chevron-right-circle"
          size={30}
          color={colors.inatGreen}
          disabled={selectedMediaIndex >= mediaCount - 1}
          accessibilityLabel={t( "Next-slide" )}
          onPress={( ) => goToMedia( 1 )}
          testID="IdentifyView.nextPhoto"
        />
      </View>

      {/* Zoom + brightness sliders (below the image, not covering it). Kept in
          the layout but inert when there's no photo to zoom or brighten, so the
          buttons below don't jump around between observations. */}
      <ZoomBrightnessSliders
        disabled={!currentPhotoUrl}
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

      {/* Current id'ed taxon — common name only, tap for species details.
          Hidden with opacity rather than unmounted until the photo has been on
          screen for a moment, so the layout doesn't shift as it appears. */}
      <View
        className={classnames(
          "px-4 py-2 items-center justify-center",
          { "opacity-0": !taxonShown },
        )}
        pointerEvents={taxonShown
          ? "auto"
          : "none"}
        accessibilityElementsHidden={!taxonShown}
      >
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
