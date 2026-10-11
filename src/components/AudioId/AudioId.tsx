/* eslint-disable i18next/no-literal-string */
import { useNavigation } from "@react-navigation/native";
import { fetchSpeciesCounts } from "api/observations";
import {
  Body1, Body3, Button, Heading4, List2,
} from "components/SharedComponents";
import { Pressable, ScrollView, View } from "components/styledComponents";
import React, { useEffect, useMemo } from "react";
import { useCurrentUser } from "sharedHooks";
import useAuthenticatedQuery from "sharedHooks/useAuthenticatedQuery";
import colors from "styles/tailwindColors";

import type { AudioIdSpecies } from "./audioIdModel";
import type { VibrateMode } from "./audioIdSession";
import useAudioIdSession, { heardIn } from "./audioIdSession";

const VIBRATE_OPTIONS: [VibrateMode, string][] = [
  ["never", "Never"],
  ["new", "A new bird"],
  ["unseen", "A bird I haven't seen"],
];

// Animal classes the model covers, for asking which of them the user has seen.
const SEEN_TAXON_IDS = [
  3, // birds
  20978, // amphibians
  47158, // insects
  40151, // mammals
  26036, // reptiles
].join( "," );
const SEEN_MAX_PAGES = 10;

// Taxon IDs the user has research-grade observations of, including the
// ancestors of any subspecies-level observations. Needs the network; without
// it nothing is marked as not yet seen.
const useSeenTaxonIds = ( userId: number | undefined ): Set<number> => {
  const { data } = useAuthenticatedQuery(
    ["audioIdSeenTaxa", userId],
    async optsWithAuth => {
      const pages = [];
      for ( let page = 1; page <= SEEN_MAX_PAGES; page += 1 ) {
        // eslint-disable-next-line no-await-in-loop
        const p = await fetchSpeciesCounts( {
          user_id: userId,
          quality_grade: "research",
          taxon_id: SEEN_TAXON_IDS,
          per_page: 500,
          page,
        }, optsWithAuth );
        pages.push( p );
        if ( !p?.results || p.results.length < 500 ) break;
      }
      return pages;
    },
    { enabled: !!userId },
  );
  return useMemo( ( ) => {
    const ids = new Set<number>( );
    ( data || [] ).forEach( page => ( page?.results || [] ).forEach(
      ( r: { taxon: { id: number; ancestor_ids?: number[] } } ) => {
        ids.add( r.taxon.id );
        r.taxon.ancestor_ids?.forEach( id => ids.add( id ) );
      },
    ) );
    return ids;
  }, [data] );
};

const AudioId = ( ) => {
  const navigation = useNavigation( );
  const {
    listening, error, current, level, inferMs, heard, setup, vibrateMode,
    setVibrateMode, setSeen, start, stop,
  } = useAudioIdSession( );
  const species = useMemo( ( ) => setup?.species || [], [setup] );
  const currentUser = useCurrentUser( );
  const seen = useSeenTaxonIds( currentUser?.id );
  useEffect( ( ) => setSeen( seen ), [seen, setSeen] );

  const outputOf = useMemo(
    ( ) => new Map( species.map( ( sp, i ) => [sp.taxonId, i] ) ),
    [species],
  );
  const scoreNow = ( taxonId: number ) => current[outputOf.get( taxonId ) ?? -1] || 0;
  const isHeardNow = useMemo( ( ) => heardIn( current ), [current] );
  const hearingNow = ( taxonId: number ) => listening && isHeardNow( scoreNow( taxonId ) );
  const heardList = Object.values( heard ).sort( ( a, b ) => b.lastHeard - a.lastHeard );
  const bestNow = current.length
    ? current.indexOf( Math.max( ...current ) )
    : -1;
  // RMS of -60 dBFS reads as empty, 0 dBFS as full.
  const meter = Math.max( 0, Math.min( 1, 1 + Math.log10( level + 1e-9 ) / 3 ) );

  const openTaxon = ( taxonId: number ) => navigation.navigate( "TaxonDetails", { id: taxonId } );

  // Species being heard right now are highlighted in yellow.
  const row = ( sp: AudioIdSpecies, score: number, detail?: string ) => (
    <Pressable
      key={sp.taxonId}
      accessibilityRole="button"
      accessibilityHint="Opens the species page."
      className={`flex-row items-center py-2 px-2 border-b border-lightGray ${
        hearingNow( sp.taxonId )
          ? "bg-yellow"
          : ""}`}
      onPress={( ) => openTaxon( sp.taxonId )}
    >
      <View className="flex-1">
        <Body1>{sp.commonName}</Body1>
        <List2 className="italic">{sp.name}</List2>
        {detail && <Body3>{detail}</Body3>}
        {currentUser && !seen.has( sp.taxonId ) && (
          <Body3 className="text-inatGreen">Not yet seen at research grade</Body3>
        )}
      </View>
      <Body1>{`${Math.round( score * 100 )}%`}</Body1>
    </Pressable>
  );

  return (
    <ScrollView className="bg-white h-full px-5 pt-4">
      <Body3 className="mb-3">
        {`Identifies ${setup
          ? `${species.length} birds and other animals${setup.located
            ? " likely here this week"
            : " (allow location to limit birds to those likely here)"}`
          : "birds and other animals"} by sound, on device and offline, `
          + "from the last 5 seconds of audio, and keeps listening elsewhere in the app "
          + "and in the background. Species you are hearing now are highlighted. "
          + "Powered by BirdNET."}
      </Body3>
      <Button
        level={listening
          ? "warning"
          : "focus"}
        text={listening
          ? "STOP LISTENING"
          : "START LISTENING"}
        onPress={listening
          ? stop
          : start}
      />
      <Body3 className="mt-4 mb-1">Vibrate when I hear:</Body3>
      <View className="flex-row">
        {VIBRATE_OPTIONS.map( ( [mode, label] ) => (
          <Pressable
            key={mode}
            accessibilityRole="button"
            accessibilityState={{ selected: vibrateMode === mode }}
            className={`flex-1 mr-1 py-2 rounded-lg border border-darkGray ${
              vibrateMode === mode
                ? "bg-darkGray"
                : ""
            }`}
            onPress={( ) => setVibrateMode( mode )}
          >
            <Body3
              className={`text-center ${vibrateMode === mode
                ? "text-white"
                : ""}`}
            >
              {label}
            </Body3>
          </Pressable>
        ) )}
      </View>
      {error && <Body3 className="mt-2 text-warningRed">{error}</Body3>}
      {listening && (
        <View className="h-2 bg-lightGray rounded-full mt-4 overflow-hidden">
          <View
            className="h-2 rounded-full"
            style={{ width: `${meter * 100}%`, backgroundColor: colors.inatGreen }}
          />
        </View>
      )}
      {listening && (
        <Body3 className="mt-1">
          {bestNow >= 0 && species[bestNow]
            ? `Best guess: ${species[bestNow].commonName} ${
              Math.round( current[bestNow] * 100 )}% · ${inferMs.toFixed( 0 )} ms`
            : "Listening… first result after 5 seconds"}
        </Body3>
      )}

      <Heading4 className="mt-6 mb-1">HEARD THIS SESSION</Heading4>
      {heardList.length === 0 && <Body3 className="py-2">Nothing yet.</Body3>}
      {heardList.map( h => row(
        h.sp,
        hearingNow( h.sp.taxonId )
          ? scoreNow( h.sp.taxonId )
          : h.best,
        `${h.count} ${h.count === 1
          ? "time"
          : "times"}, last at ${new Date( h.lastHeard ).toLocaleTimeString( )}`,
      ) )}
      <View className="h-20" />
    </ScrollView>
  );
};

export default AudioId;
