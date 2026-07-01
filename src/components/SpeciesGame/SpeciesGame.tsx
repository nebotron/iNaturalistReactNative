import { useNavigation, useRoute } from "@react-navigation/native";
import type { SharedZoomableImageRef } from "components/MediaViewer/SharedZoomableImage";
import SharedZoomableImage from "components/MediaViewer/SharedZoomableImage";
import {
  ActivityIndicator,
  Body1,
  Body2,
  Button,
  Modal,
} from "components/SharedComponents";
import BackButton from "components/SharedComponents/Buttons/BackButton";
import { SharedStackViewWrapper } from "components/SharedComponents/ViewWrapper";
import { Pressable, ScrollView, View } from "components/styledComponents";
import type {
  NoBottomTabStackScreenProps,
  TabStackScreenProps,
} from "navigation/types";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Dimensions, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { saveAnimalCrop } from "sharedHelpers/animalCropLog";
import fetchCoarseUserLocation from "sharedHelpers/fetchCoarseUserLocation";
import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { computeContainRect } from "sharedHelpers/normalizedCropTypes";
import {
  recordGuess,
  getStats,
} from "sharedHelpers/speciesGameStats";
import useSubjectDetectionForUri, {
  preloadSubjectDetectionForUri,
} from "sharedHelpers/useSubjectDetectionForUri";

const INATURALIST_API = "https://api.inaturalist.org/v1";
const POOL_SIZE = 20;
const LOOKALIKE_RADIUS_KM = 500;
const LOCATION_FILTER_RADIUS_KM = 1000;
const MAX_ZOOM_SCALE = 5;

const gameStyles = StyleSheet.create( {
  imageContainer: { flex: 1, overflow: "hidden" },
  imageStyle: { flex: 1 },
  playingButtonRow: { minHeight: 56 },
  modalScrollView: { flex: 1 },
} );

function cropToZoomTransform(
  crop: NormalizedCrop,
  viewportSize: number,
  imageWidth: number,
  imageHeight: number,
): ImageZoomTransform {
  const contain = computeContainRect( viewportSize, viewportSize, imageWidth, imageHeight );
  if ( contain.width <= 0 || contain.height <= 0 ) {
    return {
      scale: 1, translateX: 0, translateY: 0, focalX: 0, focalY: 0,
    };
  }
  const centerX = viewportSize / 2;
  const centerY = viewportSize / 2;
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
    focalX: ( centerX - cx ) * scale,
    focalY: ( centerY - cy ) * scale,
  };
}

interface TaxonInfo {
  id: number;
  name: string;
  preferredCommonName?: string;
}

interface PhotoEntry {
  url: string;
  observationUuid: string;
}

interface LookalikeEntry {
  taxonId: number;
  name: string;
  commonName?: string;
  count: number;
  observationUuids: string[];
}

interface LookalikeCandidate {
  info: TaxonInfo;
  pool: PhotoEntry[];
  weight: number; // misidentification count
}

type GamePhase = "loading" | "playing" | "revealed";

interface RouteParams {
  taxonId: number;
}

const SpeciesGame = ( ) => {
  const navigation = useNavigation<
    NoBottomTabStackScreenProps<"SpeciesGame">["navigation"] &
    TabStackScreenProps<"SpeciesGame">["navigation"]
  >( );
  const { params } = useRoute( );
  const { taxonId } = params as RouteParams;

  const [phase, setPhase] = useState<GamePhase>( "loading" );
  const [loadError, setLoadError] = useState<string | null>( null );
  const [target, setTarget] = useState<TaxonInfo | null>( null );
  const [lookalike, setLookalike] = useState<TaxonInfo | null>( null );
  const [round, setRound] = useState( 1 );
  const [score, setScore] = useState( 0 );
  const [totalGuesses, setTotalGuesses] = useState( 0 );
  const [isTargetShown, setIsTargetShown] = useState( true );

  // Load accumulated stats from previous sessions on mount
  useEffect( ( ) => {
    const savedStats = getStats( taxonId );
    if ( savedStats ) {
      setScore( savedStats.correct );
      setTotalGuesses( savedStats.total );
    }
  }, [taxonId] );
  const [currentPhotoUrl, setCurrentPhotoUrl] = useState<string | null>( null );
  const [imageLoading, setImageLoading] = useState( false );
  const [currentObservationUuid, setCurrentObservationUuid] = useState<string | null>( null );
  // true = guessed target, false = guessed lookalike, "skip" = I don't know, null = not yet guessed
  const [guessedTarget, setGuessedTarget] = useState<boolean | "skip" | null>( null );
  const [showLookalikesModal, setShowLookalikesModal] = useState( false );
  const [lookalikesData, setLookalikesData] = useState<LookalikeEntry[]>( [] );
  const [usedMisidentifications, setUsedMisidentifications] = useState( false );

  const targetPoolRef = useRef<PhotoEntry[]>( [] );
  const lookalikePoolRef = useRef<PhotoEntry[]>( [] );
  const lookalikeCandidatesRef = useRef<LookalikeCandidate[]>( [] );
  const usedUuidsRef = useRef<Set<string>>( new Set( ) );

  const windowWidth = Dimensions.get( "window" ).width;
  const { bottom: bottomInset } = useSafeAreaInsets( );
  const imageRef = useRef<SharedZoomableImageRef>( null );
  const detection = useSubjectDetectionForUri( currentPhotoUrl ?? undefined );

  const detectionRef = useRef( detection );
  useEffect( ( ) => { detectionRef.current = detection; }, [detection] );
  const currentPhotoUrlRef = useRef( currentPhotoUrl );
  useEffect( ( ) => { currentPhotoUrlRef.current = currentPhotoUrl; }, [currentPhotoUrl] );

  // Reset zoom to full image when the photo URL changes.
  useEffect( ( ) => {
    imageRef.current?.applyTransform( {
      scale: 1, translateX: 0, translateY: 0, focalX: 0, focalY: 0,
    } );
  }, [currentPhotoUrl] );

  // Zoom to detected subject when detection is available.
  useEffect( ( ) => {
    if ( !detection || !imageRef.current ) return;
    const transform = cropToZoomTransform(
      detection.crop,
      windowWidth,
      detection.imageWidth,
      detection.imageHeight,
    );
    imageRef.current.applyTransform( transform );
  }, [detection, windowWidth] );

  const handleInteractionEnd = useCallback( ( ) => {
    setTimeout( ( ) => {
      const url = currentPhotoUrlRef.current;
      const det = detectionRef.current;
      if ( !url || !det || !imageRef.current ) return;
      const transform = imageRef.current.readTransform( );
      const crop = imageZoomTransformToNormalizedCrop(
        det.imageWidth,
        det.imageHeight,
        windowWidth,
        windowWidth,
        windowWidth,
        transform,
      );
      saveAnimalCrop( url, crop );
    }, 400 );
  }, [windowWidth] );

  const taxonLabel = ( t: TaxonInfo ) => t.preferredCommonName || t.name;

  const selectWeightedLookalike = useCallback( ( ): LookalikeCandidate | null => {
    const cs = lookalikeCandidatesRef.current;
    if ( cs.length === 0 ) return null;
    const totalWeight = cs.reduce( ( sum, c ) => sum + c.weight, 0 );
    let roll = Math.random( ) * totalWeight;
    for ( const c of cs ) {
      roll -= c.weight;
      if ( roll <= 0 ) return c;
    }
    return cs[cs.length - 1];
  }, [] );

  const fetchPhotoPool = useCallback( async ( id: number ): Promise<PhotoEntry[]> => {
    const url = `${INATURALIST_API}/observations`
      + `?taxon_id=${id}`
      + "&quality_grade=research"
      + "&photos=true"
      + "&sounds=false"
      + `&per_page=${POOL_SIZE}`
      + "&fields=uuid,observation_photos";
    const res = await fetch( url );
    const data = await res.json( );
    const entries: PhotoEntry[] = [];
    for ( const obs of data.results ?? [] ) {
      const first = ( obs.observation_photos ?? [] )[0];
      const raw: string | undefined = first?.photo?.url;
      if ( raw && obs.uuid ) {
        entries.push( {
          url: raw.replace( /square\.(jpe?g|png|gif|webp)$/i, "medium.$1" ),
          observationUuid: obs.uuid,
        } );
      }
    }
    return entries;
  }, [] );

  const startRound = useCallback( (
    targetPool: PhotoEntry[],
    lookalikePool: PhotoEntry[],
  ) => {
    const showTarget = Math.random( ) < 0.5;
    const pool = showTarget
      ? targetPool
      : lookalikePool;
    const unused = pool.filter( e => !usedUuidsRef.current.has( e.observationUuid ) );
    const candidates = unused.length > 0
      ? unused
      : pool;
    const entry = candidates[Math.floor( Math.random( ) * candidates.length )] ?? null;
    if ( entry ) usedUuidsRef.current.add( entry.observationUuid );
    setIsTargetShown( showTarget );
    setCurrentPhotoUrl( entry?.url ?? null );
    setImageLoading( !!entry?.url );
    setCurrentObservationUuid( entry?.observationUuid ?? null );
    setGuessedTarget( null );
    setPhase( "playing" );

    // Preload subject detection for the next 3 images from each pool so that
    // when those images are shown the snap-to-subject zoom happens instantly.
    const PRELOAD_COUNT = 3;
    const unusedTarget = targetPool.filter( e => !usedUuidsRef.current.has( e.observationUuid ) );
    const unusedLookalike = lookalikePool.filter(
      e => !usedUuidsRef.current.has( e.observationUuid ),
    );
    [
      ...unusedTarget.slice( 0, PRELOAD_COUNT ),
      ...unusedLookalike.slice( 0, PRELOAD_COUNT ),
    ].forEach( e => preloadSubjectDetectionForUri( e.url ) );
  }, [] );

  // Scans 400 random observations of taxonId near the user's location and returns all
  // species-level taxa that appeared as alternate identifications, sorted by frequency.
  // Also records which observation UUIDs contained each misidentification.
  const findMisidentifiedLookalikes = useCallback( async (
    id: number,
    prefetchedLocation?: { latitude: number; longitude: number } | null,
  ): Promise<{
    topId: number | null;
    entries: { taxonId: number; count: number; observationUuids: string[] }[];
  }> => {
    const location = await fetchCoarseUserLocation( );
    const locationParams = location
      ? `&lat=${location.latitude}&lng=${location.longitude}&radius=${LOOKALIKE_RADIUS_KM}`
      : "";
    const baseUrl = `${INATURALIST_API}/observations`
      + `?taxon_id=${id}${
        locationParams
      }&per_page=200`
      + "&order_by=random";
    const [res1, res2] = await Promise.all( [
      fetch( `${baseUrl}&page=1` ),
      fetch( `${baseUrl}&page=2` ),
    ] );
    const results: unknown[] = [];
    if ( res1.ok ) {
      const d = await res1.json( );
      results.push( ...( d.results ?? [] ) );
    }
    if ( res2.ok ) {
      const d = await res2.json( );
      results.push( ...( d.results ?? [] ) );
    }
    if ( results.length === 0 ) return { topId: null, entries: [] };
    const data = { results };

    const counts: Record<number, { count: number; observationUuids: string[] }> = {};
    for ( const obs of data.results ?? [] ) {
      for ( const ident of obs.identifications ?? [] ) {
        const altId: number | undefined = ident.taxon?.id;
        const rankLevel: number | undefined = ident.taxon?.rank_level;
        // Only count species-level taxa (not subspecies) that differ from the target
        if ( altId && altId !== id && rankLevel === 10 ) {
          if ( !counts[altId] ) counts[altId] = { count: 0, observationUuids: [] };
          counts[altId].count += 1;
          if ( obs.uuid && !counts[altId].observationUuids.includes( obs.uuid ) ) {
            counts[altId].observationUuids.push( obs.uuid );
          }
        }
      }
    }

    const entries = Object.entries( counts )
      .map( ( [taxonId, d] ) => ( {
        taxonId: Number( taxonId ),
        count: d.count,
        observationUuids: d.observationUuids,
      } ) )
      .sort( ( a, b ) => b.count - a.count );

    return { topId: entries.length > 0 ? entries[0].taxonId : null, entries };
  }, [] );

  // Fetches basic taxon info (name, common name) by ID.
  const fetchTaxonInfo = useCallback( async ( id: number ): Promise<TaxonInfo | null> => {
    const res = await fetch(
      `${INATURALIST_API}/taxa/${id}`
        + "?fields=preferred_common_name,name,rank_level",
    );
    if ( !res.ok ) return null;
    const data = await res.json( );
    const t = data.results?.[0];
    if ( !t ) return null;
    return { id, name: t.name, preferredCommonName: t.preferred_common_name };
  }, [] );

  useEffect( ( ) => {
    let cancelled = false;

    const loadGame = async ( ) => {
      try {
        const taxonRes = await fetch(
          `${INATURALIST_API}/taxa/${taxonId}`
            + "?fields=ancestor_ids,preferred_common_name,name,rank",
        );
        const taxonData = await taxonRes.json( );
        const taxon = taxonData.results?.[0];
        if ( !taxon || cancelled ) return;

        // Fetch user location once so it can be reused for both lookalike detection
        // and candidate filtering without duplicate GPS/network calls.
        const userLocation = await fetchCoarseUserLocation( );

        // Find the most-confused species via identification disagreements.
        const { topId: misidentifiedId, entries: misidentEntries }
          = await findMisidentifiedLookalikes( taxonId, userLocation );

        // Filter misidentification candidates to species actually found within 1000km.
        const locationFilterParams = userLocation
          ? `&lat=${userLocation.latitude}&lng=${userLocation.longitude}`
            + `&radius=${LOCATION_FILTER_RADIUS_KM}`
          : "";
        const nearbyMisidentEntries = locationFilterParams
          ? await ( async ( ) => {
            const checks = await Promise.all(
              misidentEntries.map( async entry => {
                const res = await fetch(
                  `${INATURALIST_API}/observations`
                    + `?taxon_id=${entry.taxonId}${locationFilterParams}&per_page=1`,
                );
                if ( !res.ok ) return true; // fail open
                const d = await res.json( );
                return ( d.total_results ?? 0 ) > 0;
              } ),
            );
            return misidentEntries.filter( ( _, i ) => checks[i] );
          } )( )
          : misidentEntries;

        // Build weighted candidate list from misidentified species only.
        // Exclude the target species itself from all candidate lists.
        const weightedCandidates: { id: number; weight: number }[] = nearbyMisidentEntries
          .filter( ( e: { taxonId: number } ) => e.taxonId !== taxonId )
          .map( ( e: { taxonId: number; count: number } ) => ( {
            id: e.taxonId,
            weight: e.count,
          } ) );

        if ( weightedCandidates.length === 0 ) {
          if ( !cancelled ) setLoadError( "No similar species found to compare against." );
          return;
        }

        const targetPool = await fetchPhotoPool( taxonId );
        if ( cancelled ) return;
        if ( targetPool.length === 0 ) {
          if ( !cancelled ) setLoadError( "Not enough photos found for this species." );
          return;
        }

        // Find the first viable lookalike sequentially so the game starts immediately.
        let firstLookalike: LookalikeCandidate | null = null;
        let firstIndex = -1;
        for ( let i = 0; i < weightedCandidates.length; i += 1 ) {
          if ( cancelled ) return;
          const { id: candidateId, weight } = weightedCandidates[i];
          // Sequential fetching is intentional: we try each candidate until one has photos.
          // eslint-disable-next-line no-await-in-loop
          const [info, pool] = await Promise.all( [
            fetchTaxonInfo( candidateId ),
            fetchPhotoPool( candidateId ),
          ] );
          if ( info && pool.length > 0 ) {
            firstLookalike = { info, pool, weight };
            firstIndex = i;
            break;
          }
        }

        if ( cancelled ) return;

        if ( !firstLookalike ) {
          if ( !cancelled ) setLoadError( "Not enough photos found for this species pair." );
          return;
        }

        lookalikeCandidatesRef.current = [firstLookalike];
        targetPoolRef.current = targetPool;
        lookalikePoolRef.current = firstLookalike.pool;

        setTarget( {
          id: taxonId,
          name: taxon.name,
          preferredCommonName: taxon.preferred_common_name,
        } );
        setLookalike( firstLookalike.info );

        // Fetch names for all misidentification-based lookalikes in the background
        // so the game starts immediately without waiting.
        if ( misidentifiedId !== null && nearbyMisidentEntries.length > 0 ) {
          setUsedMisidentifications( true );
          Promise.all(
            nearbyMisidentEntries
              .filter( e => e.taxonId !== taxonId )
              .slice( 0, 10 )
              .map( async entry => {
                const info = await fetchTaxonInfo( entry.taxonId );
                return {
                  taxonId: entry.taxonId,
                  count: entry.count,
                  observationUuids: entry.observationUuids,
                  name: info?.name ?? String( entry.taxonId ),
                  commonName: info?.preferredCommonName,
                };
              } ),
          ).then( withNames => {
            if ( !cancelled ) setLookalikesData( withNames );
          } ).catch( ( ) => { /* best-effort, ignore errors */ } );
        }

        startRound( targetPool, firstLookalike.pool );

        // Load remaining lookalike candidates in the background so future rounds
        // rotate through all species weighted by misidentification frequency.
        const remainingCandidates = weightedCandidates.filter( ( _, i ) => i !== firstIndex );
        Promise.all(
          remainingCandidates.map( async ( { id, weight } ) => {
            const [info, pool] = await Promise.all( [
              fetchTaxonInfo( id ),
              fetchPhotoPool( id ),
            ] );
            if ( info && pool.length > 0 ) {
              return { info, pool, weight } as LookalikeCandidate;
            }
            return null;
          } ),
        ).then( results => {
          if ( cancelled ) return;
          const valid = results.filter( ( r ): r is LookalikeCandidate => r !== null );
          const existingIds = new Set( lookalikeCandidatesRef.current.map( c => c.info.id ) );
          const newCandidates = valid.filter( c => !existingIds.has( c.info.id ) );
          if ( newCandidates.length > 0 ) {
            lookalikeCandidatesRef.current = [...lookalikeCandidatesRef.current, ...newCandidates];
          }
        } ).catch( ( ) => { /* best-effort */ } );
      } catch ( _e ) {
        if ( !cancelled ) setLoadError( "Failed to load game data. Please try again." );
      }
    };

    loadGame( );
    return ( ) => { cancelled = true; };
  }, [taxonId, fetchPhotoPool, fetchTaxonInfo, findMisidentifiedLookalikes, startRound] );

  const handleGuess = useCallback( ( guessIsTarget: boolean ) => {
    const correct = guessIsTarget === isTargetShown;
    setGuessedTarget( guessIsTarget );
    if ( correct ) setScore( prev => prev + 1 );
    setTotalGuesses( prev => prev + 1 );
    recordGuess( taxonId, correct );
    setPhase( "revealed" );
  }, [isTargetShown, taxonId] );

  const handleSkip = useCallback( ( ) => {
    setGuessedTarget( "skip" );
    setPhase( "revealed" );
  }, [] );

  const handleNext = useCallback( ( ) => {
    setRound( prev => prev + 1 );
    const selected = selectWeightedLookalike( );
    if ( selected ) {
      lookalikePoolRef.current = selected.pool;
      setLookalike( selected.info );
    }
    startRound( targetPoolRef.current, lookalikePoolRef.current );
  }, [startRound, selectWeightedLookalike] );

  const accuracyStr = totalGuesses > 0
    ? `${score}/${totalGuesses} (${Math.round( ( score / totalGuesses ) * 100 )}% accuracy)`
    : "0/0";

  if ( phase === "loading" || !target || !lookalike ) {
    return (
      <SharedStackViewWrapper>
        <View className="flex-row items-center px-3 py-2 bg-white border-b border-lightGray">
          <BackButton inCustomHeader />
        </View>
        <View className="flex-1 items-center justify-center px-6">
          {loadError
            ? <Body1 className="text-center text-warningRed">{loadError}</Body1>
            : <ActivityIndicator />}
        </View>
      </SharedStackViewWrapper>
    );
  }

  const isSkip = guessedTarget === "skip";
  const isCorrect = !isSkip && guessedTarget === isTargetShown;
  const shownTaxon = isTargetShown
    ? target!
    : lookalike!;

  let targetButtonLevel: string | undefined;
  if ( phase !== "revealed" || isTargetShown ) {
    targetButtonLevel = "focus";
  } else if ( guessedTarget === true ) {
    targetButtonLevel = "warning";
  }

  let lookalikeButtonLevel: string | undefined;
  if ( phase === "revealed" ) {
    if ( !isTargetShown ) {
      lookalikeButtonLevel = "focus";
    } else if ( guessedTarget === false ) {
      lookalikeButtonLevel = "warning";
    }
  }

  const navToTaxon = ( id: number ) => navigation.push( "TaxonDetails", { id, rankLevel: 10 } );
  const onPressTarget = () => navToTaxon( target!.id );
  const onPressLookalike = () => navToTaxon( lookalike!.id );

  const windowHeight = Dimensions.get( "window" ).height;
  const modalContainerStyle = { maxHeight: windowHeight * 0.82, flex: 1 };
  const bottomPanelStyle = { paddingBottom: Math.max( 8, bottomInset ) };

  let resultCardBg = "bg-warningRed/20";
  let resultHeaderColor = "text-warningRed";
  let resultText = "Incorrect";
  if ( isCorrect ) {
    resultCardBg = "bg-inatGreen/20";
    resultHeaderColor = "text-inatGreen";
    resultText = "Correct!";
  } else if ( isSkip ) {
    resultCardBg = "bg-lightGray";
    resultHeaderColor = "text-darkGray";
    resultText = "It was...";
  }

  const lookalikesModalContent = (
    <View
      className="bg-white rounded-t-3xl"
      style={modalContainerStyle}
    >
      <View className="items-center pt-3 pb-1">
        <View className="w-10 h-1 bg-lightGray rounded-full" />
      </View>
      {/* eslint-disable-next-line i18next/no-literal-string */}
      <Body1 className="text-center font-bold px-4 pt-2 pb-1">
        Why these species?
      </Body1>

      <ScrollView className="px-4" style={gameStyles.modalScrollView}>
        {usedMisidentifications
          ? (
            <>
              <Body2 className="text-center text-darkGray pb-3">
                {`Based on 400 random observations of ${taxonLabel( target! )}`
                  + " near your location, these species were most often identified instead:"}
              </Body2>
              {lookalikesData.length === 0
                ? <ActivityIndicator />
                : lookalikesData.map( entry => (
                  <View key={entry.taxonId} className="mb-4 p-3 bg-lightGray rounded-lg">
                    <Body1 className="font-bold">
                      {entry.commonName ?? entry.name}
                    </Body1>
                    {entry.commonName && (
                      <Body2 className="italic text-darkGray">{entry.name}</Body2>
                    )}
                    <Body2 className="mt-1">
                      {`Misidentified ${entry.count} time${entry.count !== 1
                        ? "s"
                        : ""}`}
                    </Body2>
                    <View className="flex-row flex-wrap mt-1 gap-x-3">
                      {entry.observationUuids.map( ( uuid, i ) => (
                        <Pressable
                          accessibilityRole="button"
                          key={uuid}
                          onPress={() => {
                            setShowLookalikesModal( false );
                            navigation.navigate(
                              "ObsDetails" as never,
                              { uuid } as never,
                            );
                          }}
                        >
                          <Body2 className="text-inatGreen underline">
                            {`Obs ${i + 1}`}
                          </Body2>
                        </Pressable>
                      ) )}
                    </View>
                  </View>
                ) )}
            </>
          )
          : (
            <Body2 className="text-center text-darkGray pb-3">
              {"No misidentification data was found near your location. "
                + `${taxonLabel( lookalike! )} is a related species in the same taxonomic group.`}
            </Body2>
          )}
        <View className="pt-2 pb-6">
          <Button
            text="Close"
            onPress={() => setShowLookalikesModal( false )}
            level="focus"
            className="w-full"
          />
        </View>
      </ScrollView>
    </View>
  );

  return (
    <SharedStackViewWrapper>
      {/* Lookalikes explanation modal */}
      <Modal
        showModal={showLookalikesModal}
        closeModal={() => setShowLookalikesModal( false )}
        modal={lookalikesModalContent}
      />

      {/* Header bar */}
      <View
        // eslint-disable-next-line max-len
        className="flex-row items-center justify-between px-3 py-2 bg-white border-b border-lightGray"
      >
        <BackButton inCustomHeader />
        <Body2 className="font-bold">{accuracyStr}</Body2>
        <Pressable
          accessibilityRole="button"
          className="w-11 h-11 items-center justify-center"
          onPress={() => setShowLookalikesModal( true )}
        >
          <Body1 className="text-inatGreen font-bold">?</Body1>
        </Pressable>
      </View>

      {/* Photo area — fills remaining space */}
      <View style={gameStyles.imageContainer}>
        {currentPhotoUrl
          ? (
            <>
              <SharedZoomableImage
                ref={imageRef}
                uri={currentPhotoUrl}
                style={gameStyles.imageStyle}
                isDoubleTapEnabled
                maxScale={50}
                onInteractionEnd={handleInteractionEnd}
                onLoad={() => setImageLoading( false )}
                onError={() => setImageLoading( false )}
              />
              {imageLoading && (
                <View
                  className="absolute inset-0 bg-lightGray items-center justify-center"
                  style={{ ...StyleSheet.absoluteFillObject }}
                >
                  <ActivityIndicator />
                </View>
              )}
            </>
          )
          : (
            <View className="flex-1 bg-lightGray items-center justify-center">
              <ActivityIndicator />
            </View>
          )}
      </View>

      {/* Bottom panel */}
      <View className="bg-white px-4 pt-4" style={bottomPanelStyle}>
        {phase === "revealed" && (
          <View className={`mb-3 p-3 rounded-lg ${resultCardBg}`}>
            <Body1 className={`text-center font-bold ${resultHeaderColor}`}>
              {resultText}
            </Body1>
            {currentObservationUuid
              ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => navigation.navigate(
                    "ObsDetails" as never,
                    { uuid: currentObservationUuid } as never,
                  )}
                >
                  <Body2 className="text-center mt-1 italic text-inatGreen underline">
                    {`This is ${taxonLabel( shownTaxon )} (${shownTaxon.name})`}
                  </Body2>
                </Pressable>
              )
              : (
                <Body2 className="text-center mt-1 italic">
                  {`This is ${taxonLabel( shownTaxon )} (${shownTaxon.name})`}
                </Body2>
              )}
          </View>
        )}

        {phase === "playing"
          ? (
            <View className="flex-row mb-3 gap-2" style={gameStyles.playingButtonRow}>
              <View className="flex-1">
                <Button
                  className="w-full"
                  text="Yes"
                  level="focus"
                  adjustsFontSizeToFit
                  onPress={() => handleGuess( true )}
                />
              </View>
              <View className="flex-1">
                <Button
                  className="w-full"
                  text="I don't know"
                  adjustsFontSizeToFit
                  onPress={handleSkip}
                />
              </View>
              <View className="flex-1">
                <Button
                  className="w-full"
                  text="No"
                  adjustsFontSizeToFit
                  onPress={() => handleGuess( false )}
                />
              </View>
            </View>
          )
          : (
            <View className="flex-row mb-3 gap-2">
              <View className="flex-1">
                <Button
                  className="w-full"
                  text={taxonLabel( target! )}
                  level={targetButtonLevel}
                  onPress={onPressTarget}
                />
              </View>
              <View className="flex-1">
                <Button
                  className="w-full"
                  text={taxonLabel( lookalike! )}
                  level={lookalikeButtonLevel}
                  onPress={onPressLookalike}
                />
              </View>
            </View>
          )}

        {phase === "revealed" && (
          <Button
            className="w-full max-w-[500px] self-center mb-2"
            text="Next"
            level="focus"
            onPress={handleNext}
          />
        )}
      </View>
    </SharedStackViewWrapper>
  );
};

export default SpeciesGame;
