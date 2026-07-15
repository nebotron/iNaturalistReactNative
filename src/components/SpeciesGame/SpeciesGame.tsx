import { prefetch } from "@candlefinance/faster-image";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { IdentifyPhotoHandle } from "components/MediaViewer/IdentifyPhoto";
import {
  clampZoom,
  IdentifyPhoto,
  MIN_ZOOM,
  ZoomBrightnessSliders,
  zoomPosToScale,
} from "components/MediaViewer/IdentifyPhoto";
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
import { Dimensions, Linking, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import fetchCoarseUserLocation from "sharedHelpers/fetchCoarseUserLocation";
import {
  addUsedUuid,
  getStats,
  getUsedUuids,
  recordGuess,
} from "sharedHelpers/speciesGameStats";
import {
  preloadSubjectDetectionForUri,
  resolveSubjectDetectionForUri,
} from "sharedHelpers/useSubjectDetectionForUri";
import {
  useIdentifyPhotoBrightness,
  useTranslation,
} from "sharedHooks";
import {
  EXPOSURE_STOPS_MAX,
  EXPOSURE_STOPS_MIN,
} from "sharedHooks/useIdentifyPhotoBrightness";
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
// Max pages of observations we'll page through per taxon to keep supplying fresh,
// never-before-seen images (POOL_SIZE * MAX_POOL_PAGES photos per taxon).
const MAX_POOL_PAGES = 25;
const LOOKALIKE_RADIUS_KM = 500;
const LOCATION_FILTER_RADIUS_KM = 1000;
const LOOKALIKE_CACHE_KEY = "speciesGameLookalikes";
const MAX_LOOKALIKE_OBS = 1000;
const FETCH_MORE_OBS_COUNT = 400;
const LOOKALIKE_PAGE_SIZE = 200;

interface LookalikeCacheEntry {
  entries: { taxonId: number; count: number; observationUuids: string[] }[];
  topId: number | null;
  obsScanned: number;
}

function computeLookalikesFromObs(
  results: unknown[],
  targetId: number,
  seed?: { taxonId: number; count: number; observationUuids: string[] }[],
): {
  topId: number | null;
  entries: { taxonId: number; count: number; observationUuids: string[] }[];
} {
  const counts: Record<number, { count: number; observationUuids: string[] }> = {};
  for ( const s of seed ?? [] ) {
    counts[s.taxonId] = { count: s.count, observationUuids: [...s.observationUuids] };
  }
  for ( const obs of results ) {
    for ( const ident of ( obs as { identifications?: unknown[] } ).identifications ?? [] ) {
      const altId: number | undefined = ( ident as { taxon?: { id?: number } } ).taxon?.id;
      const rankLevel: number | undefined
        = ( ident as { taxon?: { rank_level?: number } } ).taxon?.rank_level;
      if ( altId && altId !== targetId && rankLevel === 10 ) {
        if ( !counts[altId] ) counts[altId] = { count: 0, observationUuids: [] };
        counts[altId].count += 1;
        const { uuid } = ( obs as { uuid?: string } );
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
  return {
    topId: entries.length > 0
      ? entries[0].taxonId
      : null,
    entries,
  };
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
  buttonRow: { height: BUTTON_ROW_HEIGHT },
  modalScrollView: { flex: 1 },
  filterCheckbox: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginBottom: 8,
  },
  filterCheckboxSelected: { backgroundColor: "#E0F2F1" },
} );

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
  const [, setRound] = useState( 1 );
  const [score, setScore] = useState( 0 );
  const [totalGuesses, setTotalGuesses] = useState( 0 );
  const [isTargetShown, setIsTargetShown] = useState( true );
  const [currentPhotoUrl, setCurrentPhotoUrl] = useState<string | null>( null );
  const [imageLoading, setImageLoading] = useState( false );
  const [currentObservationUuid, setCurrentObservationUuid] = useState<string | null>( null );
  // true = guessed target, false = guessed lookalike, "skip" = I don't know, null = not yet guessed
  const [guessedTarget, setGuessedTarget] = useState<boolean | "skip" | null>( null );
  const [showLookalikesModal, setShowLookalikesModal] = useState( false );
  const [lookalikesData, setLookalikesData] = useState<LookalikeEntry[]>( [] );
  const [usedMisidentifications, setUsedMisidentifications] = useState( false );
  const [obsScannedCount, setObsScannedCount] = useState( 0 );
  const [isFetchingMoreObs, setIsFetchingMoreObs] = useState( false );
  const [selectedObsTypes, setSelectedObsTypes] = useState<ObservationType[]>( [] );
  const [selectedSexes, setSelectedSexes] = useState<SexType[]>( [] );
  const [showFilterModal, setShowFilterModal] = useState( false );

  const targetPoolRef = useRef<PhotoEntry[]>( [] );
  const lookalikePoolRef = useRef<PhotoEntry[]>( [] );
  const lookalikeIdRef = useRef<number | null>( null );
  const lookalikeCandidatesRef = useRef<LookalikeCandidate[]>( [] );
  const usedUuidsRef = useRef<Set<string>>( new Set( ) );
  const userLocationRef = useRef<{ latitude: number; longitude: number } | null>( null );
  // Next API page already loaded per taxon id, so refills fetch new observations.
  const poolPagesRef = useRef<Record<number, number>>( {} );

  // Load accumulated stats and used UUIDs from previous sessions on mount
  useEffect( ( ) => {
    const savedStats = getStats( taxonId );
    if ( savedStats ) {
      setScore( savedStats.correct );
      setTotalGuesses( savedStats.total );
    }
    usedUuidsRef.current = getUsedUuids( taxonId );
  }, [taxonId] );

  const windowWidth = Dimensions.get( "window" ).width;
  const { bottom: bottomInset } = useSafeAreaInsets( );
  const { t } = useTranslation( );
  const photoRef = useRef<IdentifyPhotoHandle | null>( null );
  const [zoomScale, setZoomScale] = useState( MIN_ZOOM );
  const {
    brightness, displayUri, brightnessStops, setBrightnessStops, handleBrightnessComplete,
    previewBrightness, isOffMode,
  } = useIdentifyPhotoBrightness( currentPhotoUrl ?? undefined );

  // Reset zoom for the visible photo (brightness resets itself via
  // useIdentifyPhotoBrightness).
  useEffect( ( ) => { setZoomScale( MIN_ZOOM ); }, [currentPhotoUrl] );

  // Applies the slider's live value directly to the image (bypassing a full
  // re-render per tick, same as handleZoomChange does for zoom) so the
  // preview tracks the finger exactly, not just the value at release.
  const handleBrightnessChange = useCallback( ( value: number ) => {
    setBrightnessStops( value );
    photoRef.current?.setBrightness( previewBrightness( value ) );
  }, [previewBrightness, setBrightnessStops] );

  const handleScaleChange = useCallback(
    ( scale: number ) => setZoomScale( clampZoom( scale ) ),
    [],
  );
  const handleZoomChange = useCallback( ( pos: number ) => {
    const scale = zoomPosToScale( pos );
    setZoomScale( scale );
    photoRef.current?.applyZoom( scale );
  }, [] );

  const taxonLabel = ( taxonInfo: TaxonInfo ) => taxonInfo.preferredCommonName || taxonInfo.name;

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
    page = 1,
  ): Promise<PhotoEntry[]> => {
    const url = new URL( `${INATURALIST_API}/observations` );
    url.searchParams.append( "taxon_id", String( id ) );
    url.searchParams.append( "quality_grade", "research" );
    url.searchParams.append( "photos", "true" );
    url.searchParams.append( "sounds", "false" );
    url.searchParams.append( "per_page", String( POOL_SIZE ) );
    url.searchParams.append( "page", String( page ) );
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

  const unusedIn = useCallback(
    ( pool: PhotoEntry[] ) => pool.filter( e => !usedUuidsRef.current.has( e.observationUuid ) ),
    [],
  );

  // Fetches the next page of observations for a taxon and appends any never-before-seen
  // photos to its pool (in place, so shared pool references stay in sync). Returns true
  // when new photos were added.
  const refillPool = useCallback( async (
    id: number,
    pool: PhotoEntry[],
  ): Promise<boolean> => {
    const page = ( poolPagesRef.current[id] ?? 1 ) + 1;
    if ( page > MAX_POOL_PAGES ) return false;
    poolPagesRef.current[id] = page;
    let more: PhotoEntry[] = [];
    try {
      more = await fetchPhotoPool(
        id,
        selectedObsTypes.length > 0
          ? selectedObsTypes
          : undefined,
        selectedSexes.length > 0
          ? selectedSexes
          : undefined,
        page,
      );
    } catch {
      return false;
    }
    const existing = new Set( pool.map( e => e.observationUuid ) );
    let addedAny = false;
    for ( const entry of more ) {
      if ( !existing.has( entry.observationUuid ) ) {
        pool.push( entry );
        addedAny = true;
      }
    }
    return addedAny;
  }, [fetchPhotoPool, selectedObsTypes, selectedSexes] );

  // Returns unused photos in a pool, fetching more pages from the API until at least one
  // fresh photo is available or the taxon's observations are exhausted.
  const unusedWithRefill = useCallback( async (
    id: number | null,
    pool: PhotoEntry[],
  ): Promise<PhotoEntry[]> => {
    let unused = unusedIn( pool );
    while ( unused.length === 0 && id != null ) {
      // eslint-disable-next-line no-await-in-loop
      const added = await refillPool( id, pool );
      if ( !added ) break;
      unused = unusedIn( pool );
    }
    return unused;
  }, [refillPool, unusedIn] );

  const startRound = useCallback( async (
    targetPool: PhotoEntry[],
    lookalikePool: PhotoEntry[],
    nextLookalike?: TaxonInfo,
  ) => {
    // Clear the observation UUID immediately so the previous round's species name
    // does not flash while the next round's photo and state are loading.
    setCurrentObservationUuid( null );
    // Always pick a pool fairly (50/50). Never re-show a photo and never fall back to
    // the other pool: draw only from unused entries, paging in more from the API as needed.
    const showTarget = Math.random( ) < 0.5;
    const chosen = showTarget
      ? { id: taxonId, pool: targetPool }
      : { id: lookalikeIdRef.current, pool: lookalikePool };
    const unused = await unusedWithRefill( chosen.id, chosen.pool );

    const entry = unused.length > 0
      ? unused[Math.floor( Math.random( ) * unused.length )]
      : null;
    if ( entry ) addUsedUuid( taxonId, entry.observationUuid, usedUuidsRef.current );

    // Resolve the subject detection for the chosen photo *before* showing it, so the
    // image renders already cropped to the subject instead of snapping into place
    // after a visible delay. This is normally instant, since the photo was already
    // preloaded while the previous round was being played.
    if ( entry ) await resolveSubjectDetectionForUri( entry.url );

    // Only now update the displayed lookalike, so the "How to ID X vs Y" button on the
    // previous round's reveal screen doesn't spoil the upcoming species while this
    // round's photo was still being fetched above.
    if ( nextLookalike ) setLookalike( nextLookalike );
    setIsTargetShown( chosen.id === taxonId );
    setCurrentPhotoUrl( entry?.url ?? null );
    setImageLoading( !!entry?.url );
    setCurrentObservationUuid( entry?.observationUuid ?? null );
    setGuessedTarget( null );
    setPhase( "playing" );

    // Preload the next 5 images and their subject detection for each pool so that
    // when those images are shown they appear instantly, already cropped to the
    // subject, with no delay or shift.
    const PRELOAD_COUNT = 5;
    const upcoming = [
      ...unusedIn( targetPool ).slice( 0, PRELOAD_COUNT ),
      ...unusedIn( lookalikePool ).slice( 0, PRELOAD_COUNT ),
    ];
    prefetch( upcoming.map( e => e.url ) );
    upcoming.forEach( e => preloadSubjectDetectionForUri( e.url ) );
  }, [taxonId, unusedIn, unusedWithRefill] );

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

  // Fetches another batch of random observations of the target taxon and merges any
  // newly found misidentifications into the cached lookalike data and the modal display.
  const handleFetchMoreObservations = useCallback( async ( ) => {
    setIsFetchingMoreObs( true );
    try {
      const cached = getCachedLookalikes( taxonId );
      const baseObsScanned = cached?.obsScanned ?? obsScannedCount;
      const seedEntries = cached?.entries ?? [];

      const location = userLocationRef.current;
      const locationParams = location
        ? `&lat=${location.latitude}&lng=${location.longitude}&radius=${LOOKALIKE_RADIUS_KM}`
        : "";
      const baseUrl = `${INATURALIST_API}/observations`
        + `?taxon_id=${taxonId}${locationParams}&per_page=${LOOKALIKE_PAGE_SIZE}&order_by=random`;
      const startPage = Math.floor( baseObsScanned / LOOKALIKE_PAGE_SIZE ) + 1;
      const pageCount = FETCH_MORE_OBS_COUNT / LOOKALIKE_PAGE_SIZE;
      const pages = Array.from( { length: pageCount }, ( _, i ) => startPage + i );

      const responses = await Promise.all( pages.map( p => fetch( `${baseUrl}&page=${p}` ) ) );
      const newResults: unknown[] = [];
      for ( const res of responses ) {
        if ( res.ok ) {
          // eslint-disable-next-line no-await-in-loop
          const d = await res.json( );
          newResults.push( ...( d.results ?? [] ) );
        }
      }

      const merged = computeLookalikesFromObs( newResults, taxonId, seedEntries );
      const newObsScanned = baseObsScanned + newResults.length;
      setCachedLookalikes( taxonId, {
        entries: merged.entries,
        topId: merged.topId,
        obsScanned: newObsScanned,
      } );
      setObsScannedCount( newObsScanned );
      setUsedMisidentifications( merged.entries.length > 0 );

      const knownNames = new Map(
        lookalikesData.map( e => [e.taxonId, { name: e.name, commonName: e.commonName }] ),
      );
      const withNames = await Promise.all(
        merged.entries.slice( 0, 10 ).map( async entry => {
          const known = knownNames.get( entry.taxonId );
          if ( known ) return { ...entry, ...known };
          const info = await fetchTaxonInfo( entry.taxonId );
          return {
            taxonId: entry.taxonId,
            count: entry.count,
            observationUuids: entry.observationUuids,
            name: info?.name ?? String( entry.taxonId ),
            commonName: info?.preferredCommonName,
          };
        } ),
      );
      setLookalikesData( withNames );
    } finally {
      setIsFetchingMoreObs( false );
    }
  }, [taxonId, obsScannedCount, lookalikesData, fetchTaxonInfo] );

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
        userLocationRef.current = userLocation;

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
          selectedObsTypes.length > 0
            ? selectedObsTypes
            : undefined,
          selectedSexes.length > 0
            ? selectedSexes
            : undefined,
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
              selectedObsTypes.length > 0
                ? selectedObsTypes
                : undefined,
              selectedSexes.length > 0
                ? selectedSexes
                : undefined,
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
        lookalikeIdRef.current = firstLookalike.info.id;

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
                selectedObsTypes.length > 0
                  ? selectedObsTypes
                  : undefined,
                selectedSexes.length > 0
                  ? selectedSexes
                  : undefined,
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
      lookalikeIdRef.current = selected.info.id;
    }
    startRound( targetPoolRef.current, lookalikePoolRef.current, selected?.info );
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
        {/* eslint-disable-next-line i18next/no-literal-string */}
        <Body2 className="text-center text-darkGray pb-3">
          Select one or more life stages to filter observations:
        </Body2>

        {OBSERVATION_TYPES.map( obsType => {
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
                isSelected && gameStyles.filterCheckboxSelected,
              ]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isSelected }}
            >
              <Body1>
                {isSelected
                  ? "✓ "
                  : "  "}
                {obsType.label}
              </Body1>
            </Pressable>
          );
        } )}

        {/* eslint-disable-next-line i18next/no-literal-string */}
        <Body1 className="text-center font-bold px-4 pt-4 pb-1">
          Filter by Sex
        </Body1>
        {SEX_TYPES.map( sexType => {
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
                isSelected && gameStyles.filterCheckboxSelected,
              ]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isSelected }}
            >
              <Body1>
                {isSelected
                  ? "✓ "
                  : "  "}
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
                      accessibilityRole="button"
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
        <View className="pt-2 pb-2">
          <Button
            text="Search 400 More Observations"
            onPress={handleFetchMoreObservations}
            disabled={isFetchingMoreObs}
            loading={isFetchingMoreObs}
            className="w-full"
          />
        </View>
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
            {/* eslint-disable i18next/no-literal-string */}
            <Body1 className={`font-bold ${selectedObsTypes.length > 0 || selectedSexes.length > 0
              ? "text-inatGreen"
              : "text-darkGray"}`}
            >
              ≡
            </Body1>
            {/* eslint-enable i18next/no-literal-string */}
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
      <View
        // We need these dynamic dimensions to keep the image square
        // eslint-disable-next-line react-native/no-inline-styles
        style={{ width: windowWidth, height: windowWidth }}
        className="overflow-hidden"
      >
        {currentPhotoUrl
          ? (
            <>
              <IdentifyPhoto
                // Remount per photo so each frames to its own subject.
                key={currentPhotoUrl}
                ref={photoRef}
                uri={currentPhotoUrl}
                displayUri={displayUri}
                size={windowWidth}
                brightness={brightness}
                onScaleChange={handleScaleChange}
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

      {/* Zoom + brightness sliders (below the image, not covering it) */}
      <ZoomBrightnessSliders
        zoomScale={zoomScale}
        brightnessStops={brightnessStops}
        brightnessDisabled={isOffMode}
        exposureStopsMin={EXPOSURE_STOPS_MIN}
        exposureStopsMax={EXPOSURE_STOPS_MAX}
        onZoomChange={handleZoomChange}
        onZoomComplete={( ) => photoRef.current?.saveCrop( )}
        onBrightnessChange={handleBrightnessChange}
        onBrightnessComplete={handleBrightnessComplete}
        zoomAccessibilityLabel={t( "Adjust-zoom" )}
        brightnessAccessibilityLabel={t( "Adjust-brightness" )}
      />

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
              {target && lookalike && (
                <Button
                  className="w-full mb-2"
                  // eslint-disable-next-line i18next/no-literal-string
                  text={`How to ID ${taxonLabel( target )} vs ${taxonLabel( lookalike )}`}
                  onPress={() => {
                    const query = encodeURIComponent(
                      `how to id ${taxonLabel( target! )} vs ${taxonLabel( lookalike! )}`,
                    );
                    Linking.openURL( `https://www.google.com/search?q=${query}` );
                  }}
                />
              )}
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
