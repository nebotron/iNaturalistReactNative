import Slider from "@react-native-community/slider";
import { useNavigation } from "@react-navigation/native";
import { createIdentification } from "api/identifications";
import { markAsReviewed } from "api/observations";
import type { ApiObservation, ApiObservationsSearchParams } from "api/types";
import useInfiniteExploreScroll from "components/Explore/hooks/useInfiniteExploreScroll";
import type { SharedZoomableImageRef } from "components/MediaViewer/SharedZoomableImage";
import SharedZoomableImage from "components/MediaViewer/SharedZoomableImage";
import {
  ActivityIndicator,
  Body2,
  Button,
  INatIcon,
  INatIconButton,
} from "components/SharedComponents";
import DisplayTaxonName from "components/SharedComponents/DisplayTaxonName";
import { View } from "components/styledComponents";
import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Dimensions, StyleSheet } from "react-native";
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
import {
  useAuthenticatedMutation,
  useCurrentUser,
  useTranslation,
} from "sharedHooks";
import colors from "styles/tailwindColors";

// Exposure slider in stops (EV); the gain applied to the image is 2^stops.
const EXPOSURE_STOPS_MIN = -1;
const EXPOSURE_STOPS_MAX = 4;
const EXPOSURE_STOPS_DEFAULT = 0;
const stopsToGain = ( stops: number ) => 2 ** stops;
const gainToStops = ( gain: number ) => Math.min(
  EXPOSURE_STOPS_MAX,
  Math.max( EXPOSURE_STOPS_MIN, Math.log2( gain ) ),
);

// Zoom slider: exponential mapping so equal slider travel is equal zoom ratio.
// Slider position runs 0..1; scale runs MIN_ZOOM..MAX_ZOOM as MIN * (MAX/MIN)^pos.
const MIN_ZOOM = 1;
const MAX_ZOOM = 50;
const clampZoom = ( scale: number ) => Math.min( MAX_ZOOM, Math.max( MIN_ZOOM, scale ) );
const zoomPosToScale = ( pos: number ) => MIN_ZOOM * ( MAX_ZOOM / MIN_ZOOM ) ** pos;
const zoomScaleToPos = ( scale: number ) => Math.min(
  1,
  Math.max( 0, Math.log( clampZoom( scale ) / MIN_ZOOM ) / Math.log( MAX_ZOOM / MIN_ZOOM ) ),
);

// Fetch the next page once we're within this many observations of the end.
const PREFETCH_THRESHOLD = 5;

const IDENTITY_TRANSFORM: ImageZoomTransform = {
  scale: 1, translateX: 0, translateY: 0, focalX: 0, focalY: 0,
};

const styles = StyleSheet.create( {
  image: { flex: 1 },
  slider: { flex: 1, height: 36, marginLeft: 8 },
  container: { paddingTop: 30 },
  buttonRow: { height: 60 },
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
  const scale = clampZoom( Math.min(
    viewportSize / ( crop.w * contain.width ),
    viewportSize / ( crop.h * contain.height ),
  ) );
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

interface IdentifyPhotoHandle {
  applyZoom: ( scale: number ) => void;
  saveCrop: ( ) => void;
}

interface IdentifyPhotoProps {
  uri: string;
  size: number;
  brightness: number;
  onSingleTap: ( ) => void;
  onScaleChange: ( scale: number ) => void;
}

// A single subject-framed photo with one- or two-finger pan/zoom. The framed
// viewport is saved to the crop log (which syncs to Firebase) whenever a
// gesture or slider zoom ends.
const IdentifyPhoto = memo( forwardRef<IdentifyPhotoHandle, IdentifyPhotoProps>( ( {
  uri,
  size,
  brightness,
  onSingleTap,
  onScaleChange,
}, ref ) => {
  const imageRef = useRef<SharedZoomableImageRef | null>( null );
  const dimsRef = useRef<{ width: number; height: number } | null>( null );
  const appliedRef = useRef( false );
  const detection = useSubjectDetectionForUri( uri );

  const saveCrop = useCallback( ( ) => {
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
  }, [size, uri] );

  // Rescale the image while keeping whatever is currently at the viewport
  // centre fixed there (rather than snapping back to the image centre).
  const applyZoom = useCallback( ( scale: number ) => {
    const img = imageRef.current;
    const dims = dimsRef.current;
    if ( !img ) return;
    const contain = dims
      ? computeContainRect( size, size, dims.width, dims.height )
      : null;
    if ( !dims || !contain || contain.width <= 0 || contain.height <= 0 ) {
      img.applyTransform( {
        scale, translateX: 0, translateY: 0, focalX: 0, focalY: 0,
      } );
      return;
    }
    const crop = imageZoomTransformToNormalizedCrop(
      dims.width, dims.height, size, size, size, img.readTransform( ),
    );
    const centre = size / 2;
    const cxScreen = contain.left + ( crop.x + crop.w / 2 ) * contain.width;
    const cyScreen = contain.top + ( crop.y + crop.h / 2 ) * contain.height;
    img.applyTransform( {
      scale,
      translateX: 0,
      translateY: 0,
      focalX: ( centre - cxScreen ) * scale,
      focalY: ( centre - cyScreen ) * scale,
    } );
  }, [size] );

  useImperativeHandle( ref, ( ) => ( { applyZoom, saveCrop } ), [applyZoom, saveCrop] );

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
    setTimeout( saveCrop, 400 );
  }, [saveCrop] );

  return (
    <SharedZoomableImage
      ref={imageRef}
      uri={uri}
      style={styles.image}
      brightness={brightness}
      minScale={MIN_ZOOM}
      maxScale={MAX_ZOOM}
      isDoubleTapEnabled
      isSingleTapEnabled
      onSingleTap={onSingleTap}
      onScaleChange={onScaleChange}
      onInteractionEnd={handleInteractionEnd}
      onImageDimensionsChange={dims => { dimsRef.current = dims; }}
      testID="IdentifyView.image"
    />
  );
} ) );

IdentifyPhoto.displayName = "IdentifyPhoto";

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
  const [brightnessStops, setBrightnessStops] = useState( EXPOSURE_STOPS_DEFAULT );
  const [zoomScale, setZoomScale] = useState( MIN_ZOOM );
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
  const hasMultiplePhotos = photoUrls.length > 1;

  // Reset to the first photo whenever the observation changes.
  useEffect( ( ) => {
    setSelectedPhotoIndex( 0 );
  }, [observationUuid] );

  // Reset zoom and load any previously-saved brightness for the visible photo
  // so saved adjustments round-trip.
  useEffect( ( ) => {
    setZoomScale( MIN_ZOOM );
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

  const handleBrightnessComplete = useCallback( ( value: number ) => {
    setBrightnessStops( value );
    if ( currentPhotoUrl ) saveBrightness( currentPhotoUrl, stopsToGain( value ) );
  }, [currentPhotoUrl] );

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

  const { mutate: agreeMutate, isPending: agreeing } = useAuthenticatedMutation(
    ( params, optsWithAuth ) => createIdentification( params, optsWithAuth ),
    { onSuccess: ( ) => goToNext( ) },
  );
  const { mutate: reviewMutate, isPending: reviewing } = useAuthenticatedMutation(
    ( params, optsWithAuth ) => markAsReviewed( params, optsWithAuth ),
    { onSuccess: ( ) => goToNext( ) },
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
  const isOwnObs = observation.user?.id != null && observation.user.id === currentUser?.id;
  const agreeDisabled = !currentUser || !taxon?.id || isOwnObs || agreeing;
  const reviewDisabled = !currentUser || reviewing;

  const handleAgree = ( ) => {
    if ( !observationUuid || !taxon?.id ) return;
    agreeMutate( {
      identification: { observation_id: observationUuid, taxon_id: taxon.id },
    } );
  };
  const handleReview = ( ) => {
    if ( !observationUuid ) return;
    reviewMutate( { uuid: observationUuid } );
  };

  const navButtonClass = "bg-black/50 items-center justify-center rounded-full h-[44px] w-[44px]";

  return (
    <View className="flex-1" style={styles.container}>
      {/* Square, zoomable/pannable image with subject detection. Tapping opens
          the full observation; dedicated buttons page between photos. */}
      <View
        // We need these dynamic dimensions to keep the image square
        // eslint-disable-next-line react-native/no-inline-styles
        style={{ width: windowWidth, height: windowWidth }}
        className="bg-black overflow-hidden"
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

        {/* Left / right photo navigation */}
        {hasMultiplePhotos && (
          <>
            <View className="absolute left-2 inset-y-0 justify-center">
              <INatIconButton
                icon="chevron-left-circle"
                size={30}
                color={colors.white}
                className={navButtonClass}
                disabled={selectedPhotoIndex === 0}
                accessibilityLabel={t( "Previous-slide" )}
                onPress={( ) => goToPhoto( -1 )}
                testID="IdentifyView.prevPhoto"
              />
            </View>
            <View className="absolute right-2 inset-y-0 justify-center">
              <INatIconButton
                icon="chevron-right-circle"
                size={30}
                color={colors.white}
                className={navButtonClass}
                disabled={selectedPhotoIndex === photoUrls.length - 1}
                accessibilityLabel={t( "Next-slide" )}
                onPress={( ) => goToPhoto( 1 )}
                testID="IdentifyView.nextPhoto"
              />
            </View>
            <View className="absolute top-3 right-3 bg-black/50 rounded-full px-3 py-1">
              <Body2 className="text-white">
                {`${selectedPhotoIndex + 1}/${photoUrls.length}`}
              </Body2>
            </View>
          </>
        )}
      </View>

      {/* Zoom + brightness sliders (below the image, not covering it) */}
      <View className="px-4 pt-1">
        <View className="flex-row items-center">
          <INatIcon name="magnifying-glass" size={18} color={colors.darkGray} />
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={1}
            minimumTrackTintColor={colors.inatGreen}
            maximumTrackTintColor={colors.lightGray}
            thumbTintColor={colors.inatGreen}
            value={zoomScaleToPos( zoomScale )}
            onValueChange={handleZoomChange}
            onSlidingComplete={( ) => photoRef.current?.saveCrop( )}
            tapToSeek
            accessibilityLabel={t( "Adjust-zoom" )}
          />
        </View>
        <View className="flex-row items-center">
          <INatIcon name="sliders" size={18} color={colors.darkGray} />
          <Slider
            style={styles.slider}
            minimumValue={EXPOSURE_STOPS_MIN}
            maximumValue={EXPOSURE_STOPS_MAX}
            minimumTrackTintColor={colors.inatGreen}
            maximumTrackTintColor={colors.lightGray}
            thumbTintColor={colors.inatGreen}
            value={brightnessStops}
            onValueChange={setBrightnessStops}
            onSlidingComplete={handleBrightnessComplete}
            tapToSeek
            accessibilityLabel={t( "Adjust-brightness" )}
          />
        </View>
      </View>

      {/* Current id'ed taxon — common name only */}
      <View className="px-4 py-2 items-center justify-center">
        {taxon
          ? (
            <DisplayTaxonName taxon={taxon} showOneNameOnly />
          )
          : (
            <Body2>{t( "Unknown--taxon" )}</Body2>
          )}
      </View>

      {/* Agree / Mark reviewed / Next — three equal buttons */}
      <View className="flex-row px-4 gap-2" style={styles.buttonRow}>
        <View className="flex-1">
          <Button
            className="w-full h-full"
            text={t( "Agree" )}
            level="focus"
            adjustsFontSizeToFit
            disabled={agreeDisabled}
            loading={agreeing}
            onPress={handleAgree}
            testID="IdentifyView.agree"
          />
        </View>
        <View className="flex-1">
          <Button
            className="w-full h-full"
            text={t( "Reviewed" )}
            adjustsFontSizeToFit
            disabled={reviewDisabled}
            loading={reviewing}
            onPress={handleReview}
            testID="IdentifyView.review"
          />
        </View>
        <View className="flex-1">
          <Button
            className="w-full h-full"
            text={t( "Next" )}
            adjustsFontSizeToFit
            onPress={goToNext}
            testID="IdentifyView.next"
          />
        </View>
      </View>
    </View>
  );
};

export default IdentifyView;
