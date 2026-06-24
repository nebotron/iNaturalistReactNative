import { useNavigation, useRoute } from "@react-navigation/native";
import type {
  NoBottomTabStackScreenProps,
  TabStackScreenProps,
} from "navigation/types";
import {
  ActivityIndicator,
  Body1,
  Body2,
  Button,
  INatIconButton,
} from "components/SharedComponents";
import { SharedStackViewWrapper } from "components/SharedComponents/ViewWrapper";
import SharedZoomableImage from "components/MediaViewer/SharedZoomableImage";
import { Pressable, View } from "components/styledComponents";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  getStats,
  recordGuess,
  type TaxonStats,
} from "sharedHelpers/speciesGameStats";
import colors from "styles/tailwindColors";

const INATURALIST_API = "https://api.inaturalist.org/v1";
const POOL_SIZE = 20;
const WASHINGTON_PLACE_ID = 46;

interface TaxonInfo {
  id: number;
  name: string;
  preferredCommonName?: string;
}

interface PhotoEntry {
  url: string;
  observationUuid: string;
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
  const [isTargetShown, setIsTargetShown] = useState( true );
  const [currentPhotoUrl, setCurrentPhotoUrl] = useState<string | null>( null );
  const [currentObservationUuid, setCurrentObservationUuid] = useState<string | null>( null );
  // true = guessed target, false = guessed lookalike, "skip" = I don't know, null = not yet guessed
  const [guessedTarget, setGuessedTarget] = useState<boolean | "skip" | null>( null );
  // lifetime stats for the target taxon, updated reactively after each guess
  const [lifetimeStats, setLifetimeStats] = useState<TaxonStats | null>( null );

  const targetPoolRef = useRef<PhotoEntry[]>( [] );
  const lookalikePoolRef = useRef<PhotoEntry[]>( [] );
  const usedUuidsRef = useRef<Set<string>>( new Set( ) );

  const taxonLabel = ( t: TaxonInfo ) => t.preferredCommonName || t.name;

  const refreshLifetimeStats = useCallback( ( ) => {
    setLifetimeStats( getStats( taxonId ) );
  }, [taxonId] );

  const fetchPhotoPool = useCallback( async ( id: number ): Promise<PhotoEntry[]> => {
    const url = `${INATURALIST_API}/observations`
      + `?taxon_id=${id}`
      + `&quality_grade=research`
      + `&photos=true`
      + `&sounds=false`
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
    const pool = showTarget ? targetPool : lookalikePool;
    const unused = pool.filter( e => !usedUuidsRef.current.has( e.observationUuid ) );
    const candidates = unused.length > 0 ? unused : pool;
    const entry = candidates[Math.floor( Math.random( ) * candidates.length )] ?? null;
    if ( entry ) usedUuidsRef.current.add( entry.observationUuid );
    setIsTargetShown( showTarget );
    setCurrentPhotoUrl( entry?.url ?? null );
    setCurrentObservationUuid( entry?.observationUuid ?? null );
    setGuessedTarget( null );
    setPhase( "playing" );
  }, [] );

  // Returns the taxon ID most commonly confused with taxonId, by scanning
  // a random sample of observations for identifications proposing a different
  // species-level taxon.  Returns null if the sample contains no disagreements.
  const findMisidentifiedLookalike = useCallback( async (
    id: number,
  ): Promise<number | null> => {
    const res = await fetch(
      `${INATURALIST_API}/observations`
        + `?taxon_id=${id}`
        + `&place_id=${WASHINGTON_PLACE_ID}`
        + "&per_page=100",
    );
    if ( !res.ok ) return null;
    const data = await res.json( );

    const counts: Record<number, number> = {};
    for ( const obs of data.results ?? [] ) {
      for ( const ident of obs.identifications ?? [] ) {
        const altId: number | undefined = ident.taxon?.id;
        const rankLevel: number | undefined = ident.taxon?.rank_level;
        // Only count species-level taxa (not subspecies) that differ from the target
        if ( altId && altId !== id && rankLevel === 10 ) {
          counts[altId] = ( counts[altId] ?? 0 ) + 1;
        }
      }
    }

    const sorted = Object.entries( counts ).sort( ( [, a], [, b] ) => b - a );
    return sorted.length > 0 ? Number( sorted[0][0] ) : null;
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
    refreshLifetimeStats( );

    const loadGame = async ( ) => {
      try {
        const taxonRes = await fetch(
          `${INATURALIST_API}/taxa/${taxonId}`
            + "?fields=ancestor_ids,preferred_common_name,name,rank",
        );
        const taxonData = await taxonRes.json( );
        const taxon = taxonData.results?.[0];
        if ( !taxon || cancelled ) return;

        // Primary strategy: find the most-confused species via identification disagreements.
        // Fallback: use a sibling in the same parent taxon.
        const misidentifiedId = await findMisidentifiedLookalike( taxonId );

        // Build a prioritized list of lookalike candidates.
        let siblingCandidates: number[] = [];
        if ( misidentifiedId === null ) {
          const parentId = taxon.ancestor_ids?.[taxon.ancestor_ids.length - 1];
          if ( !parentId ) {
            if ( !cancelled ) setLoadError( "No similar species found to compare against." );
            return;
          }
          const siblingsRes = await fetch(
            `${INATURALIST_API}/taxa`
              + `?parent_id=${parentId}`
              + `&rank=${taxon.rank}`
              + "&per_page=12"
              + "&order_by=observations_count"
              + "&order=desc"
              + "&fields=id,preferred_common_name,name",
          );
          const siblingsData = await siblingsRes.json( );
          const siblings = ( siblingsData.results ?? [] ).filter(
            ( s: { id: number } ) => s.id !== taxonId,
          );
          if ( siblings.length === 0 ) {
            if ( !cancelled ) setLoadError( "No similar species found to compare against." );
            return;
          }
          // Shuffle so we don't always pick the most-observed sibling.
          const shuffled = [...siblings].sort( ( ) => Math.random( ) - 0.5 );
          siblingCandidates = shuffled.map( ( s: { id: number } ) => s.id );
        }

        const candidates = misidentifiedId !== null
          ? [misidentifiedId]
          : siblingCandidates;

        const targetPool = await fetchPhotoPool( taxonId );
        if ( cancelled ) return;
        if ( targetPool.length === 0 ) {
          if ( !cancelled ) setLoadError( "Not enough photos found for this species." );
          return;
        }

        // Try candidates in order until one has photos.
        let lookalikeInfo: TaxonInfo | null = null;
        let lookalikePool: PhotoEntry[] = [];
        for ( const candidateId of candidates ) {
          if ( cancelled ) return;
          const [info, pool] = await Promise.all( [
            fetchTaxonInfo( candidateId ),
            fetchPhotoPool( candidateId ),
          ] );
          if ( info && pool.length > 0 ) {
            lookalikeInfo = info;
            lookalikePool = pool;
            break;
          }
        }

        if ( cancelled ) return;

        if ( !lookalikeInfo || lookalikePool.length === 0 ) {
          if ( !cancelled ) setLoadError( "Not enough photos found for this species pair." );
          return;
        }

        targetPoolRef.current = targetPool;
        lookalikePoolRef.current = lookalikePool;

        setTarget( {
          id: taxonId,
          name: taxon.name,
          preferredCommonName: taxon.preferred_common_name,
        } );
        setLookalike( lookalikeInfo );

        startRound( targetPool, lookalikePool );
      } catch ( _e ) {
        if ( !cancelled ) setLoadError( "Failed to load game data. Please try again." );
      }
    };

    loadGame( );
    return ( ) => { cancelled = true; };
  }, [taxonId, fetchPhotoPool, fetchTaxonInfo, findMisidentifiedLookalike, startRound, refreshLifetimeStats] );

  const handleGuess = useCallback( ( guessIsTarget: boolean ) => {
    const correct = guessIsTarget === isTargetShown;
    setGuessedTarget( guessIsTarget );
    if ( correct ) setScore( prev => prev + 1 );
    recordGuess( taxonId, correct );
    refreshLifetimeStats( );
    setPhase( "revealed" );
  }, [isTargetShown, taxonId, refreshLifetimeStats] );

  const handleSkip = useCallback( ( ) => {
    setGuessedTarget( "skip" );
    setPhase( "revealed" );
  }, [] );

  const handleNext = useCallback( ( ) => {
    setRound( prev => prev + 1 );
    startRound( targetPoolRef.current, lookalikePoolRef.current );
  }, [startRound] );

  const lifetimeBadge = lifetimeStats
    ? `${lifetimeStats.correct}/${lifetimeStats.total} lifetime`
    : null;

  if ( phase === "loading" || !target || !lookalike ) {
    return (
      <SharedStackViewWrapper>
        <View className="flex-row items-center px-3 py-2 bg-white border-b border-lightGray">
          <INatIconButton
            icon="arrow-back"
            onPress={() => navigation.goBack()}
            accessibilityLabel="Go back"
            size={22}
            color={colors.darkGray}
          />
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
  const shownTaxon = isTargetShown ? target! : lookalike!;

  const targetButtonLevel = ( ) => {
    if ( phase !== "revealed" ) return "focus";
    if ( isTargetShown ) return "focus";
    if ( guessedTarget === true ) return "warning";
    return undefined;
  };
  const lookalikeButtonLevel = ( ) => {
    if ( phase !== "revealed" ) return undefined;
    if ( !isTargetShown ) return "focus";
    if ( guessedTarget === false ) return "warning";
    return undefined;
  };

  return (
    <SharedStackViewWrapper>
      {/* Header bar */}
      <View className="flex-row items-center justify-between px-3 py-2 bg-white border-b border-lightGray">
        <INatIconButton
          icon="arrow-back"
          onPress={() => navigation.goBack()}
          accessibilityLabel="Go back"
          size={22}
          color={colors.darkGray}
        />
        <View className="items-center">
          <Body2 className="font-bold">{`Round ${round}  ·  ${score} correct`}</Body2>
          {lifetimeBadge && (
            <Body2 className="text-inatGreen">{lifetimeBadge}</Body2>
          )}
        </View>
        {/* spacer to keep center aligned */}
        <View style={{ width: 44 }} />
      </View>

      {/* Photo area */}
      <View className="flex-1">
        {currentPhotoUrl
          ? (
            <SharedZoomableImage
              uri={currentPhotoUrl}
              style={{ flex: 1 }}
            />
          )
          : (
            <View className="flex-1 bg-lightGray items-center justify-center">
              <ActivityIndicator />
            </View>
          )}
      </View>

      {/* Bottom panel */}
      <View className="bg-white px-4 pt-4 pb-2">
        <Body1 className="text-center mb-3">Which species is this?</Body1>

        {phase === "revealed" && (
          <View
            className={`mb-3 p-3 rounded-lg ${isCorrect ? "bg-inatGreen/20" : isSkip ? "bg-lightGray" : "bg-warningRed/20"}`}
          >
            <Body1
              className={`text-center font-bold ${isCorrect ? "text-inatGreen" : isSkip ? "text-darkGray" : "text-warningRed"}`}
            >
              {isCorrect ? "Correct!" : isSkip ? "It was..." : "Incorrect"}
            </Body1>
            <Body2 className="text-center mt-1 italic">
              {`This is ${taxonLabel( shownTaxon )} (${shownTaxon.name})`}
            </Body2>
            {currentObservationUuid && (
              <Pressable
                onPress={() => navigation.navigate( "ObsDetails" as never, { uuid: currentObservationUuid } as never )}
              >
                <Body2 className="text-center mt-1 text-inatGreen underline">
                  View observation
                </Body2>
              </Pressable>
            )}
          </View>
        )}

        <View className="flex-row mb-3">
          <View className="flex-1 mr-2">
            <Button
              className="w-full"
              text={taxonLabel( target! )}
              level={targetButtonLevel()}
              onPress={() => {
                if ( phase === "playing" ) handleGuess( true );
                else if ( phase === "revealed" ) navigation.push( "TaxonDetails", { id: target!.id } );
              }}
            />
          </View>
          <View className="flex-1 ml-2">
            <Button
              className="w-full"
              text={taxonLabel( lookalike! )}
              level={lookalikeButtonLevel()}
              onPress={() => {
                if ( phase === "playing" ) handleGuess( false );
                else if ( phase === "revealed" ) navigation.push( "TaxonDetails", { id: lookalike!.id } );
              }}
            />
          </View>
        </View>
        {phase === "playing" && (
          <Button
            className="w-full max-w-[500px] self-center mb-2"
            text="I don't know"
            onPress={handleSkip}
          />
        )}

        {phase === "revealed" && (
          <Body2 className="text-center text-darkGray mb-1">
            Tap a species to view its page
          </Body2>
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
