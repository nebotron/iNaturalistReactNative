import { useNavigation, useRoute } from "@react-navigation/native";
import {
  ActivityIndicator,
  Body1,
  Body2,
  Button,
  Heading2,
  INatIconButton,
} from "components/SharedComponents";
import { SharedStackViewWrapper } from "components/SharedComponents/ViewWrapper";
import { Image, View } from "components/styledComponents";
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
const ROUNDS = 10;
const POOL_SIZE = 20;

interface TaxonInfo {
  id: number;
  name: string;
  preferredCommonName?: string;
}

type GamePhase = "loading" | "playing" | "revealed" | "done";

interface RouteParams {
  taxonId: number;
}

const pct = ( stats: TaxonStats ) => Math.round( ( stats.correct / stats.total ) * 100 );

const SpeciesGame = ( ) => {
  const navigation = useNavigation( );
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
  // true = guessed target, false = guessed lookalike, null = not yet guessed
  const [guessedTarget, setGuessedTarget] = useState<boolean | null>( null );
  // lifetime stats for the target taxon, updated reactively after each guess
  const [lifetimeStats, setLifetimeStats] = useState<TaxonStats | null>( null );

  const targetPoolRef = useRef<string[]>( [] );
  const lookalikePoolRef = useRef<string[]>( [] );

  const taxonLabel = ( t: TaxonInfo ) => t.preferredCommonName || t.name;

  const refreshLifetimeStats = useCallback( ( ) => {
    setLifetimeStats( getStats( taxonId ) );
  }, [taxonId] );

  const fetchPhotoPool = useCallback( async ( id: number ): Promise<string[]> => {
    const url = `${INATURALIST_API}/observations`
      + `?taxon_id=${id}`
      + `&quality_grade=research`
      + `&photos=true`
      + `&sounds=false`
      + `&order_by=random`
      + `&per_page=${POOL_SIZE}`;
    const res = await fetch( url );
    const data = await res.json( );
    const urls: string[] = [];
    for ( const obs of data.results ?? [] ) {
      const first = ( obs.observation_photos ?? [] )[0];
      const raw: string | undefined = first?.photo?.url;
      if ( raw ) {
        urls.push( raw.replace( /square/i, "medium" ) );
      }
    }
    return urls;
  }, [] );

  const startRound = useCallback( (
    targetPool: string[],
    lookalikePool: string[],
  ) => {
    const showTarget = Math.random( ) < 0.5;
    const pool = showTarget ? targetPool : lookalikePool;
    const photo = pool[Math.floor( Math.random( ) * pool.length )] ?? null;
    setIsTargetShown( showTarget );
    setCurrentPhotoUrl( photo );
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
        + "&per_page=100"
        + "&order_by=random",
    );
    if ( !res.ok ) return null;
    const data = await res.json( );

    const counts: Record<number, number> = {};
    for ( const obs of data.results ?? [] ) {
      for ( const ident of obs.identifications ?? [] ) {
        const altId: number | undefined = ident.taxon?.id;
        const rankLevel: number | undefined = ident.taxon?.rank_level;
        // Only count species-level taxa that differ from the target
        if ( altId && altId !== id && rankLevel != null && rankLevel <= 10 ) {
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
        let lookalikeId = await findMisidentifiedLookalike( taxonId );

        if ( lookalikeId === null ) {
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
          lookalikeId = siblings[
            Math.floor( Math.random( ) * Math.min( siblings.length, 5 ) )
          ].id;
        }

        const [lookalikeInfo, targetPool, lookalikePool] = await Promise.all( [
          fetchTaxonInfo( lookalikeId ),
          fetchPhotoPool( taxonId ),
          fetchPhotoPool( lookalikeId ),
        ] );

        if ( cancelled ) return;

        if ( !lookalikeInfo || targetPool.length === 0 || lookalikePool.length === 0 ) {
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

  const handleNext = useCallback( ( ) => {
    if ( round >= ROUNDS ) {
      setPhase( "done" );
      return;
    }
    setRound( prev => prev + 1 );
    startRound( targetPoolRef.current, lookalikePoolRef.current );
  }, [round, startRound] );

  const handlePlayAgain = useCallback( ( ) => {
    setRound( 1 );
    setScore( 0 );
    startRound( targetPoolRef.current, lookalikePoolRef.current );
  }, [startRound] );

  const lifetimeBadge = lifetimeStats
    ? `${lifetimeStats.correct}/${lifetimeStats.total} lifetime`
    : null;

  if ( phase === "loading" || ( phase !== "done" && ( !target || !lookalike ) ) ) {
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

  if ( phase === "done" ) {
    const sessionPct = Math.round( ( score / ROUNDS ) * 100 );
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
          <Heading2 className="text-center mb-2">Game Over</Heading2>
          {target && (
            <Body2 className="text-center mb-4 italic">{taxonLabel( target )}</Body2>
          )}

          <Body1 className="text-center mb-1">
            {`Session: ${score} / ${ROUNDS} (${sessionPct}%)`}
          </Body1>
          {lifetimeStats && (
            <Body1 className="text-center mb-8 text-inatGreen font-bold">
              {`Lifetime: ${lifetimeStats.correct} / ${lifetimeStats.total} (${pct( lifetimeStats )}%)`}
            </Body1>
          )}

          <Button
            className="w-full max-w-[500px]"
            text="Play Again"
            level="focus"
            onPress={handlePlayAgain}
          />
          <Button
            className="w-full max-w-[500px] mt-4"
            text="Done"
            onPress={() => navigation.goBack()}
          />
        </View>
      </SharedStackViewWrapper>
    );
  }

  const isCorrect = guessedTarget === isTargetShown;
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
          <Body2 className="font-bold">{`Round ${round} / ${ROUNDS}  ·  ${score} correct`}</Body2>
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
            <Image
              className="w-full h-full"
              source={{ uri: currentPhotoUrl }}
              resizeMode="cover"
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
            className={`mb-3 p-3 rounded-lg ${isCorrect ? "bg-inatGreen/20" : "bg-warningRed/20"}`}
          >
            <Body1
              className={`text-center font-bold ${isCorrect ? "text-inatGreen" : "text-warningRed"}`}
            >
              {isCorrect ? "Correct!" : "Incorrect"}
            </Body1>
            <Body2 className="text-center mt-1 italic">
              {`This is ${taxonLabel( shownTaxon )} (${shownTaxon.name})`}
            </Body2>
          </View>
        )}

        <View className="flex-row mb-3">
          <View className="flex-1 mr-2">
            <Button
              className="w-full"
              text={taxonLabel( target! )}
              level={targetButtonLevel()}
              onPress={() => { if ( phase === "playing" ) handleGuess( true ); }}
              disabled={phase === "revealed"}
            />
          </View>
          <View className="flex-1 ml-2">
            <Button
              className="w-full"
              text={taxonLabel( lookalike! )}
              level={lookalikeButtonLevel()}
              onPress={() => { if ( phase === "playing" ) handleGuess( false ); }}
              disabled={phase === "revealed"}
            />
          </View>
        </View>

        {phase === "revealed" && (
          <Button
            className="w-full max-w-[500px] self-center mb-2"
            text={round >= ROUNDS ? "See Results" : "Next"}
            level="focus"
            onPress={handleNext}
          />
        )}
      </View>
    </SharedStackViewWrapper>
  );
};

export default SpeciesGame;
