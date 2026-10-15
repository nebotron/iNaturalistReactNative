/* eslint-disable i18next/no-literal-string */
import { useNavigation } from "@react-navigation/native";
import { fetchSpeciesCounts } from "api/observations";
import {
  Body1, Body3, Button, Heading4, IconicTaxonIcon, List2,
} from "components/SharedComponents";
import CachedImage from "components/SharedComponents/CachedImage";
import { Pressable, ScrollView, View } from "components/styledComponents";
import React, { useEffect, useMemo } from "react";
import type { ViewProps } from "react-native";
import { Linking, requireNativeComponent } from "react-native";
import { useCurrentUser, useTaxon } from "sharedHooks";
import useAuthenticatedQuery from "sharedHooks/useAuthenticatedQuery";

import useAudioIdHistory from "./audioIdHistory";
import type { AudioIdSpecies } from "./audioIdModel";
import useAudioIdSession, { heardIn, vibrate } from "./audioIdSession";

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
// it (or until it loads) nothing is marked as not yet seen.
const useSeenTaxonIds = ( userId: number | undefined ): Set<number> | null => {
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
        if ( !p?.results ) throw new Error( "Couldn't fetch seen taxa" );
        pages.push( p );
        if ( p.results.length < 500 ) break;
      }
      return pages;
    },
    { enabled: !!userId },
  );
  return useMemo( ( ) => {
    if ( !data ) return null;
    const ids = new Set<number>( );
    data.forEach( page => ( page?.results || [] ).forEach(
      ( r: { taxon: { id: number; ancestor_ids?: number[] } } ) => {
        ids.add( r.taxon.id );
        r.taxon.ancestor_ids?.forEach( id => ids.add( id ) );
      },
    ) );
    return ids;
  }, [data] );
};

const TaxonThumb = ( { taxonId, onPress }: { taxonId: number; onPress: ( ) => void } ) => {
  const { taxon } = useTaxon( { id: taxonId } );
  const url = taxon?.default_photo?.url;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens the species page."
      className="mr-3"
      onPress={onPress}
    >
      {url
        ? <CachedImage source={{ uri: url }} className="w-10 h-10 rounded-lg" />
        : <IconicTaxonIcon imageClassName="w-10 h-10 rounded-lg" iconicTaxonName="Aves" />}
    </Pressable>
  );
};

// The last 10 s of sound, Merlin-style: dark marks on a full-width white
// strip, low frequencies at the bottom. Drawn natively from the microphone
// audio.
const AudioSpectrogram = requireNativeComponent<ViewProps>( "AudioSpectrogram" );
const SPECTROGRAM_STYLE = { height: 140 };
const Spectrogram = ( ) => (
  <View className="mt-4 -mx-5 border-y border-lightGray">
    <AudioSpectrogram style={SPECTROGRAM_STYLE} />
  </View>
);

const AudioId = ( ) => {
  const navigation = useNavigation( );
  const {
    listening, error, current, heard, setup, setSeen, start,
    stop,
  } = useAudioIdSession( );
  const species = useMemo( ( ) => setup?.species || [], [setup] );
  const currentUser = useCurrentUser( );
  const seen = useSeenTaxonIds( currentUser?.id );
  useEffect( ( ) => setSeen( currentUser
    ? seen
    : null ), [currentUser, seen, setSeen] );

  const outputOf = useMemo(
    ( ) => new Map( species.map( ( sp, i ) => [sp.taxonId, i] ) ),
    [species],
  );
  const scoreNow = ( taxonId: number ) => current[outputOf.get( taxonId ) ?? -1] || 0;
  const isHeardNow = useMemo( ( ) => heardIn( current ), [current] );
  const hearingNow = ( taxonId: number ) => listening && isHeardNow( scoreNow( taxonId ) );
  const heardList = Object.values( heard ).sort( ( a, b ) => b.lastHeard - a.lastHeard );
  const clips = useAudioIdHistory( state => state.clips );
  const sessions = useAudioIdHistory( state => state.sessions );
  const pastSessions = useMemo( ( ) => {
    const species = new Map<string, Set<number>>( );
    Object.values( clips ).forEach( c => {
      if ( !c.sessionId ) return;
      if ( !species.has( c.sessionId ) ) species.set( c.sessionId, new Set( ) );
      species.get( c.sessionId )?.add( c.sp.taxonId );
    } );
    return Object.values( sessions )
      .filter( s => species.has( s.id ) )
      .sort( ( a, b ) => b.startedAt - a.startedAt )
      .map( s => ( { ...s, speciesCount: species.get( s.id )?.size || 0 } ) );
  }, [clips, sessions] );

  const openTaxon = ( taxonId: number ) => navigation.navigate( "TaxonDetails", {
    id: taxonId, fromAudioId: true,
  } );

  // Species being heard right now are highlighted in yellow.
  const row = ( sp: AudioIdSpecies, score: number, detail?: string ) => (
    <Pressable
      key={sp.taxonId}
      accessibilityRole="button"
      accessibilityHint="Opens the history of when this species was heard."
      className={`flex-row items-center py-2 px-2 border-b border-lightGray ${
        hearingNow( sp.taxonId )
          ? "bg-yellow"
          : ""}`}
      onPress={( ) => navigation.navigate( "AudioIdHistory", { taxonId: sp.taxonId } )}
    >
      <TaxonThumb taxonId={sp.taxonId} onPress={( ) => openTaxon( sp.taxonId )} />
      <View className="flex-1">
        <Body1>{sp.commonName}</Body1>
        <List2 className="italic">{sp.name}</List2>
        {detail && <Body3>{detail}</Body3>}
        {currentUser && seen && !seen.has( sp.taxonId ) && (
          <Body3 className="text-inatGreen">Not yet seen at research grade</Body3>
        )}
      </View>
      <Body1>{`${Math.round( score * 100 )}%`}</Body1>
    </Pressable>
  );

  return (
    <ScrollView className="bg-white h-full px-5 pt-4">
      <Body3 className="mb-3">
        {"Identifies "}
        {setup
          ? (
            <Body3
              accessibilityRole="link"
              accessibilityHint="Opens a searchable list of the species it listens for."
              className="underline"
              onPress={( ) => navigation.navigate( "AudioIdTaxa" )}
            >
              {`${species.length} animals`}
            </Body3>
          )
          : "animals"}
        {" by sound, using "}
        <Body3
          accessibilityRole="link"
          accessibilityHint="Opens the BirdNET website."
          className="underline"
          onPress={( ) => Linking.openURL( "https://birdnet.cornell.edu" )}
        >
          BirdNET
        </Body3>
        .
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
      <View className="flex-row mt-2">
        <Button
          className="flex-1 mr-1"
          text="TEST VIBRATION"
          onPress={( ) => vibrate( )}
        />
        <Button
          className="flex-1 ml-1"
          text="TEST HAPTICS"
          onPress={( ) => vibrate( true )}
        />
      </View>
      {error && <Body3 className="mt-2 text-warningRed">{error}</Body3>}
      {listening && <Spectrogram />}
      {listening && current.length === 0 && (
        <Body3 className="mt-1">Listening…</Body3>
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

      <Heading4 className="mt-6 mb-1">PAST SESSIONS</Heading4>
      {pastSessions.length === 0 && <Body3 className="py-2">None yet.</Body3>}
      {pastSessions.map( s => (
        <Pressable
          key={s.id}
          accessibilityRole="button"
          accessibilityHint="Opens everything heard in this session."
          className="py-2 px-2 border-b border-lightGray"
          onPress={( ) => navigation.navigate( "AudioIdHistory", { sessionId: s.id } )}
        >
          <Body1>{new Date( s.startedAt ).toLocaleString( )}</Body1>
          <Body3>
            {`${s.speciesCount} species${s.endedAt
              ? `, ${Math.max( 1, Math.round( ( s.endedAt - s.startedAt ) / 60000 ) )} min`
              : ""}`}
          </Body3>
        </Pressable>
      ) )}
      <View className="h-20" />
    </ScrollView>
  );
};

export default AudioId;
