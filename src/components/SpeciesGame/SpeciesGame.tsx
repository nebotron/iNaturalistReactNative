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
  getUsedUuids,
  addUsedUuid,
} from "sharedHelpers/speciesGameStats";
import useSubjectDetectionForUri, {
  preloadSubjectDetectionForUri,
} from "sharedHelpers/useSubjectDetectionForUri";
import { zustandStorage } from "stores/useStore";

type ObservationType = "egg" | "juvenile" | "adult";
type SexType = "male" | "female";

// iNaturalist filters annotations by controlled-term / value IDs, not by the
// life_stage/sex string params (which the observations endpoint silently ignores).
// Life Stage controlled term = 1, Sex controlled term = 9.
const LIFE_STAGE_TERM_ID = 1;
const SEX_TERM_ID = 9;
// Value IDs grouped under each life-stage filter option. Larva, Pupa, Nymph and
// Juvenile are grouped together under the single "Juvenile" option.
const LIFE_STAGE_VALUE_IDS: Record<ObservationType, number[]> = {
  egg: [7],
  juvenile: [6, 4, 5, 8],
  adult: [2],
};
const SEX_VALUE_IDS: Record<SexType, number> = {
  female: 10,
  male: 11,
};

const INATURALIST_API = "https://api.inaturalist.org/v1";
const POOL_SIZE = 20;
const LOOKALIKE_RADIUS_KM = 500;
const LOCATION_FILTER_RADIUS_KM = 1000;
const MAX_ZOOM_SCALE = 5;
const LOOKALIKE_CACHE_KEY = "speciesGameLookalikes";
const MAX_LOOKALIKE_OBS = 1000;

interface LookalikeCacheEntry {
  entries: { taxonId: number; count: number; observationUuids: string[] }[];
  topId: number | null;
  obsScanned: number;
}

function computeLookalikesFromObs(
  results: unknown[],
  targetId: number,
): { topId: number | null; entries: { taxonId: number; count: number; observationUuids: string[] }[] } {
  const counts: Record<number, { count: number; observationUuids: string[] }> = {};
  for ( const obs of results ) {
    for ( const ident of ( obs as { identifications?: unknown[] } ).identifications ?? [] ) {
      const altId: number | undefined = ( ident as { taxon?: { id?: number } } ).taxon?.id;
      const rankLevel: number | undefined
        = ( ident as { taxon?: { rank_level?: number } } ).taxon?.rank_level;
      if ( altId && altId !== targetId && rankLevel === 10 ) {
        if ( !counts[altId] ) counts[altId] = { count: 0, observationUuids: [] };
        counts[altId].count += 1;
        const uuid = ( obs as { uuid?: string } ).uuid;
        if ( uuid && !counts[altId].observationUuids.includes( uuid ) ) {
          counts[altId].observationUuids.push( uuid );
        }
      }
    }
  }
  const entries = Object.entries( counts )
    .map( ( [id, d] ) => ( {
      taxonId: Number( id ),
      count: d.count,
      observationUuids: d.observationUuids,
    } ) )
    .sort( ( a, b ) => b.count - a.count );
  return { topId: entries.length > 0 ? entries[0].taxonId : null, entries };
}

function getCachedLookalikes( taxonId: number ): LookalikeCacheEntry | null {
  const raw = zustandStorage.getItem( `${LOOKALIKE_CACHE_KEY}_${taxonId}` );
  if ( !raw || typeof raw !== "string" ) return null;
  try {
    return JSON.parse( raw ) as LookalikeCacheEntry;
  } catch {
    return null;
  }
}

function setCachedLookalikes( taxonId: number, value: LookalikeCacheEntry ): void {
  zustandStorage.setItem( `${LOOKALIKE_CACHE_KEY}_${taxonId}`, JSON.stringify( value ) );
}

const BUTTON_ROW_HEIGHT = 56;
const OBSERVATION_TYPES: { label: string; value: ObservationType }[] = [
  { label: "Egg", value: "egg" },
  { label: "Juvenile", value: "juvenile" },
  { label: "Adult", value: "adult" },
];
const SEX_TYPES: { label: string; value: SexType }[] = [
  { label: "Male", value: "male" },
  { label: "Female", value: "female" },
];

const gameStyles = StyleSheet.create( {
  imageStyle: { flex: 1 },
  buttonRow: { height: BUTTON_ROW_HEIGHT },
  modalScrollView: { flex: 1 },
  filterCheckbox: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginBottom: 8,
  },
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

  // Load accumulated stats and used UUIDs from previous sessions on mount
  useEffect( ( ) => {
    const savedStats = getStats( taxonId );
    if ( savedStats ) {
      setScore( savedStats.correct );
      setTotalGuesses( savedStats.total );
    }
    usedUuidsRef.current = getUsedUuids( taxonId );
  }, [taxonId] );
  const [currentPhotoUrl, setCurrentPhotoUrl] = useState<string | null>( null );
  const [imageLoading, setImageLoading] = useState( false );
  const [currentObservationUuid, setCurrentObservationUuid] = useState<string | null>( null );
  // true = guessed target, false = guessed lookalike, "skip" = I don't know, null = not yet guessed
  const [guessedTarget, setGuessedTarget] = useState<boolean | "skip" | null>( null );
  const [showLookalikesModal, setShowLookalikesModal] = useState( false );
  const [lookalikesData, setLookalikesData] = useState<LookalikeEntry[]>( [] );
  const [usedMisidentifications, setUsedMisidentifications] = useState( false );
  const [obsScannedCount, setObsScannedCount] = useState( 0 );
  const [selectedObsTypes, setSelectedObsTypes] = useState<ObservationType[]>( [] );
  const [selectedSexes, setSelectedSexes] = useState<SexType[]>( [] );
  const [showFilterModal, setShowFilterModal] = useState( false );

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

  const fetchPhotoPool = useCallback( async (
    id: number,
    filters?: ObservationType[],
    sexes?: SexType[],
  ): Promise<PhotoEntry[]> => {
    const url = new URL( `${INATURALIST_API}/observations` );
    url.searchParams.append( "taxon_id", String( id ) );
    url.searchParams.append( "quality_grade", "research" );
    url.searchParams.append( "photos", "true" );
    url.searchParams.append( "sounds", "false" );
    url.searchParams.append( "per_page", String( POOL_SIZE ) );
    url.searchParams.append( "fields", "uuid,observation_photos" );

    // Annotation filters are ANDed across terms by pairing each term_id with the
    // matching term_value_id (comma-joined value IDs are ORed within a term).
    if ( filters && filters.length > 0 ) {
      const valueIds = filters.flatMap( f => LIFE_STAGE_VALUE_IDS[f] );
      url.searchParams.append( "term_id", String( LIFE_STAGE_TERM_ID ) );
      url.searchParams.append( "term_value_id", valueIds.join( "," ) );
    }
    if ( sexes && sexes.length > 0 ) {
      const valueIds = sexes.map( s => SEX_VALUE_IDS[s] );
      url.searchParams.append( "term_id", String( SEX_TERM_ID ) );
      url.searchParams.append( "term_value_id", valueIds.join( "," ) );
    }

    const res = await fetch( url.toString( ) );
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
    if ( entry ) addUsedUuid( taxonId, entry.observationUuid, usedUuidsRef.current );
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
  }, [taxonId] );

  // Scans up to 2000 random observations of taxonId near the user's location and returns all
  // species-level taxa that appeared as alternate identifications, sorted by frequency.
  // Stops fetching early once lookalikes are found. Results are cached in persistent storage.
  const findMisidentifiedLookalikes = useCallback( async (
    id: number,
    prefetchedLocation?: { latitude: number; longitude: number } | null,
  ): Promise<{
    topId: number | null;
    entries: { taxonId: number; count: number; observationUuids: string[] }[];
    obsScanned: number;
  }> => {
    const cached = getCachedLookalikes( id );
    if ( cached ) {
      return { topId: cached.topId, entries: cached.entries, obsScanned: cached.obsScanned };
    }

    const location = prefetchedLocation ?? await fetchCoarseUserLocation( );
    const locationParams = location
      ? `&lat=${location.latitude}&lng=${location.longitude}&radius=${LOOKALIKE_RADIUS_KM}`
      : "";
    const baseUrl = `${INATURALIST_API}/observations`
      + `?taxon_id=${id}${locationParams}&per_page=200&order_by=random`;

    const PAGE_BATCH = 2;
    const MAX_PAGES = MAX_LOOKALIKE_OBS / 200;
    const allResults: unknown[] = [];

    for ( let page = 1; page <= MAX_PAGES; page += PAGE_BATCH ) {
      const pageNums = [page, page + 1].filter( p => p <= MAX_PAGES );
      // eslint-disable-next-line no-await-in-loop
      const responses = await Promise.all( pageNums.map( p => fetch( `${baseUrl}&page=${p}` ) ) );
      for ( const res of responses ) {
        if ( res.ok ) {
          // eslint-disable-next-line no-await-in-loop
          const d = await res.json( );
          allResults.push( ...( d.results ?? [] ) );
        }
      }
      const interim = computeLookalikesFromObs( allResults, id );
      if ( interim.entries.length > 0 ) break;
    }

    const result = computeLookalikesFromObs( allResults, id );
    const cacheEntry: LookalikeCacheEntry = {
      ...result,
      obsScanned: allResults.length,
    };
    setCachedLookalikes( id, cacheEntry );

    return { ...result, obsScanned: allResults.length };
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
        const {
          topId: misidentifiedId,
          entries: misidentEntries,
          obsScanned,
        } = await findMisidentifiedLookalikes( taxonId, userLocation );

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

        const targetPool = await fetchPhotoPool(
          taxonId,
          selectedObsTypes.length > 0 ? selectedObsTypes : undefined,
          selectedSexes.length > 0 ? selectedSexes : undefined,
        );
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
            fetchPhotoPool(
              candidateId,
              selectedObsTypes.length > 0 ? selectedObsTypes : undefined,
              selectedSexes.length > 0 ? selectedSexes : undefined,
            ),
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
          setObsScannedCount( obsScanned );
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
              fetchPhotoPool(
                id,
                selectedObsTypes.length > 0 ? selectedObsTypes : undefined,
                selectedSexes.length > 0 ? selectedSexes : undefined,
              ),
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
  }, [
    taxonId,
    fetchPhotoPool,
    fetchTaxonInfo,
    findMisidentifiedLookalikes,
    startRound,
    selectedObsTypes,
    selectedSexes,
  ] );

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

  const windowHeight = Dimensions.get( "window" ).height;
  const modalContainerStyle = { maxHeight: windowHeight * 0.82, flex: 1 };
  const bottomPanelStyle = { paddingBottom: Math.max( 8, bottomInset ) };

  let resultHeaderColor = "text-warningRed";
  if ( isCorrect ) {
    resultHeaderColor = "text-inatGreen";
  } else if ( isSkip ) {
    resultHeaderColor = "text-darkGray";
  }

  const filterModalContent = (
    <View
      className="bg-white rounded-t-3xl"
      style={modalContainerStyle}
    >
      <View className="items-center pt-3 pb-1">
        <View className="w-10 h-1 bg-lightGray rounded-full" />
      </View>
      {/* eslint-disable-next-line i18next/no-literal-string */}
      <Body1 className="text-center font-bold px-4 pt-2 pb-1">
        Filter by Life Stage
      </Body1>

      <ScrollView className="px-4" style={gameStyles.modalScrollView}>
        <Body2 className="text-center text-darkGray pb-3">
          {/* eslint-disable-next-line i18next/no-literal-string */}
          Select one or more life stages to filter observations:
        </Body2>

        {OBSERVATION_TYPES.map( ( obsType ) => {
          const isSelected = selectedObsTypes.includes( obsType.value );
          return (
            <Pressable
              key={obsType.value}
              onPress={() => {
                setSelectedObsTypes( prev => (
                  isSelected
                    ? prev.filter( t => t !== obsType.value )
                    : [...prev, obsType.value]
                ) );
              }}
              style={[
                gameStyles.filterCheckbox,
                isSelected && { backgroundColor: "#E0F2F1" },
              ]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isSelected }}
            >
              <Body1>
                {isSelected ? "✓ " : "  "}
                {obsType.label}
              </Body1>
            </Pressable>
          );
        } )}

        {/* eslint-disable-next-line i18next/no-literal-string */}
        <Body1 className="text-center font-bold px-4 pt-4 pb-1">
          Filter by Sex
        </Body1>
        {SEX_TYPES.map( ( sexType ) => {
          const isSelected = selectedSexes.includes( sexType.value );
          return (
            <Pressable
              key={sexType.value}
              onPress={() => {
                setSelectedSexes( prev => (
                  isSelected
                    ? prev.filter( t => t !== sexType.value )
                    : [...prev, sexType.value]
                ) );
              }}
              style={[
                gameStyles.filterCheckbox,
                isSelected && { backgroundColor: "#E0F2F1" },
              ]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isSelected }}
            >
              <Body1>
                {isSelected ? "✓ " : "  "}
                {sexType.label}
              </Body1>
            </Pressable>
          );
        } )}

        <View className="pt-4 pb-6 gap-2">
          <Button
            text="Apply"
            onPress={() => setShowFilterModal( false )}
            level="focus"
            className="w-full"
          />
          <Button
            text="Clear Filters"
            onPress={() => {
              setSelectedObsTypes( [] );
              setSelectedSexes( [] );
            }}
            className="w-full"
          />
        </View>
      </ScrollView>
    </View>
  );

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
                {`Based on ${obsScannedCount} random observations of ${taxonLabel( target! )}`
                  + " near your location, these species were most often identified instead:"}
              </Body2>
              {lookalikesData.length === 0
                ? <ActivityIndicator />
                : lookalikesData.map( entry => (
                  <View key={entry.taxonId} className="mb-4 p-3 bg-lightGray rounded-lg">
                    <Pressable
                      onPress={() => {
                        setShowLookalikesModal( false );
                        navigation.navigate(
                          "TaxonDetails" as never,
                          { id: entry.taxonId } as never,
                        );
                      }}
                    >
                      <Body1 className="font-bold text-inatGreen">
                        {entry.commonName ?? entry.name}
                      </Body1>
                      {entry.commonName && (
                        <Body2 className="italic text-inatGreen">{entry.name}</Body2>
                      )}
                    </Pressable>
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
      {/* Filter modal */}
      <Modal
        showModal={showFilterModal}
        closeModal={() => setShowFilterModal( false )}
        modal={filterModalContent}
      />

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
        <View className="flex-row gap-1">
          <Pressable
            accessibilityRole="button"
            className="w-11 h-11 items-center justify-center"
            onPress={() => setShowFilterModal( true )}
            accessibilityLabel={
              selectedObsTypes.length > 0 || selectedSexes.length > 0
                ? "Filter active"
                : "Open filter"
            }
          >
            <Body1 className={`font-bold ${selectedObsTypes.length > 0 || selectedSexes.length > 0 ? "text-inatGreen" : "text-darkGray"}`}>
              ≡
            </Body1>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            className="w-11 h-11 items-center justify-center"
            onPress={() => setShowLookalikesModal( true )}
          >
            <Body1 className="text-inatGreen font-bold">?</Body1>
          </Pressable>
        </View>
      </View>

      {/* Photo area — square to match crop */}
      <View style={{ width: windowWidth, height: windowWidth, overflow: "hidden" }}>
        {currentPhotoUrl
          ? (
            <>
              <SharedZoomableImage
                ref={imageRef}
                uri={currentPhotoUrl}
                style={gameStyles.imageStyle}
                isDoubleTapEnabled
                maxScale={100}
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
        {phase === "playing"
          ? (
            <>
              {/* eslint-disable-next-line i18next/no-literal-string */}
              <Body2 className="text-center text-darkGray mb-2">
                {`Is this ${taxonLabel( target )}?`}
              </Body2>
              <View className="flex-row mb-3 gap-2" style={gameStyles.buttonRow}>
                <View className="flex-1">
                  <Button
                    className="w-full h-full"
                    text="Yes"
                    level="focus"
                    onPress={() => handleGuess( true )}
                  />
                </View>
                <View className="flex-1">
                  <Button
                    className="w-full h-full"
                    text="IDK"
                    onPress={handleSkip}
                  />
                </View>
                <View className="flex-1">
                  <Button
                    className="w-full h-full"
                    text="No"
                    onPress={() => handleGuess( false )}
                  />
                </View>
              </View>
            </>
          )
          : (
            <View className="mb-3">
              <Button
                className="w-full mb-2"
                text="Next"
                level="focus"
                onPress={handleNext}
              />
              {currentObservationUuid && (
                <Pressable
                  accessibilityRole="button"
                  className="items-center justify-center py-1"
                  onPress={() => navigation.navigate(
                    "ObsDetails" as never,
                    { uuid: currentObservationUuid } as never,
                  )}
                >
                  <Body2 className={`text-center italic underline ${resultHeaderColor}`}>
                    {`${taxonLabel( shownTaxon )} (${shownTaxon.name})`}
                  </Body2>
                </Pressable>
              )}
            </View>
          )}
      </View>
    </SharedStackViewWrapper>
  );
};

export default SpeciesGame;
