/* eslint-disable i18next/no-literal-string */
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { activateKeepAwake, deactivateKeepAwake } from "@sayem314/react-native-keep-awake";
import { fetchSpeciesCounts } from "api/observations";
import {
  Body1, Body3, Button, IconicTaxonIcon, List2,
} from "components/SharedComponents";
import CachedImage from "components/SharedComponents/CachedImage";
import { Pressable, ScrollView, View } from "components/styledComponents";
import React, { useCallback, useEffect, useMemo } from "react";
import type { ViewProps } from "react-native";
import { Linking, requireNativeComponent } from "react-native";
import { formatISOTimestamp } from "sharedHelpers/dateAndTime";
import { useCurrentUser, useTaxon } from "sharedHooks";
import useAuthenticatedQuery from "sharedHooks/useAuthenticatedQuery";
import { UPLOAD_IN_PROGRESS } from "stores/createUploadObservationsSlice";
import useStore from "stores/useStore";

import useAudioIdHistory from "./audioIdHistory";
import type { AudioIdSpecies } from "./audioIdModel";
import type { Heard } from "./audioIdSession";
import useAudioIdSession, {
  heardIn, noteActivity, startDimming, stopDimming, vibrate,
} from "./audioIdSession";

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
// ancestors of any subspecies-level observations, observed on or after d1 if
// given. Needs the network; without it (or until it loads) nothing is marked
// as not yet seen.
const useSeenTaxonIds = (
  userId: number | undefined,
  d1?: string,
): Set<number> | null => {
  const { data } = useAuthenticatedQuery(
    ["audioIdSeenTaxa", userId, d1],
    async optsWithAuth => {
      const pages = [];
      for ( let page = 1; page <= SEEN_MAX_PAGES; page += 1 ) {
        // eslint-disable-next-line no-await-in-loop
        const p = await fetchSpeciesCounts( {
          user_id: userId,
          quality_grade: "research",
          taxon_id: SEEN_TAXON_IDS,
          d1,
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
      className="w-[80px] h-[80px]"
      onPress={onPress}
    >
      {url
        ? <CachedImage source={{ uri: url }} className="w-full h-full" />
        : <IconicTaxonIcon imageClassName="w-full h-full" iconicTaxonName="Aves" />}
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
  // Keep the display awake while this screen is focused, without cutting off
  // the keep-awake an in-progress upload holds
  useFocusEffect( useCallback( ( ) => {
    activateKeepAwake( );
    startDimming( );
    return ( ) => {
      stopDimming( );
      if ( useStore.getState( ).uploadStatus !== UPLOAD_IN_PROGRESS ) deactivateKeepAwake( );
    };
  }, [] ) );
  const {
    listening, error, current, setup, setSeen, start,
    stop,
  } = useAudioIdSession( );
  const species = useMemo( ( ) => setup?.species || [], [setup] );
  const currentUser = useCurrentUser( );
  const seen = useSeenTaxonIds( currentUser?.id );
  const monthAgo = new Date( Date.now( ) - 30 * 86400000 ).toISOString( ).slice( 0, 10 );
  const recent = useSeenTaxonIds( currentUser?.id, monthAgo );
  useEffect( ( ) => setSeen(
    currentUser
      ? seen
      : null,
    currentUser
      ? recent
      : null,
  ), [currentUser, seen, recent, setSeen] );

  const outputOf = useMemo(
    ( ) => new Map( species.map( ( sp, i ) => [sp.taxonId, i] ) ),
    [species],
  );
  const scoreNow = ( taxonId: number ) => current?.[outputOf.get( taxonId ) ?? -1] || 0;
  const isHeardNow = useMemo( ( ) => heardIn( current || {} ), [current] );
  const hearingNow = ( taxonId: number ) => listening && isHeardNow( scoreNow( taxonId ) );
  const clips = useAudioIdHistory( state => state.clips );
  // Every species ever heard, most recently heard first.
  const heardList = useMemo( ( ) => {
    const bySpecies = new Map<number, Heard>( );
    Object.values( clips ).forEach( c => {
      const h = bySpecies.get( c.sp.taxonId );
      bySpecies.set( c.sp.taxonId, {
        sp: c.sp,
        lastHeard: Math.max( h?.lastHeard || 0, c.time ),
        best: Math.max( h?.best || 0, c.confidence ),
        count: ( h?.count || 0 ) + 1,
      } );
    } );
    return [...bySpecies.values( )].sort( ( a, b ) => b.lastHeard - a.lastHeard );
  }, [clips] );
  const hasUnlabeled = useMemo( ( ) => new Set( Object.values( clips )
    .filter( c => !c.label ).map( c => c.sp.taxonId ) ), [clips] );

  const openTaxon = ( taxonId: number ) => navigation.navigate( "TaxonDetails", {
    id: taxonId, fromAudioId: true,
  } );

  // Species being heard right now are highlighted in yellow.
  const row = ( sp: AudioIdSpecies, detail?: string ) => (
    <Pressable
      key={sp.taxonId}
      accessibilityRole="button"
      accessibilityHint="Opens the history of when this species was heard."
      className={`flex-row items-center -ml-5 h-[80px] ${
        hearingNow( sp.taxonId )
          ? "bg-yellow"
          : ""}`}
      onPress={( ) => navigation.navigate( "AudioIdHistory", { taxonId: sp.taxonId } )}
    >
      <TaxonThumb taxonId={sp.taxonId} onPress={( ) => openTaxon( sp.taxonId )} />
      <View
        className="flex-1 flex-row items-center self-stretch ml-3 pr-2 border-b border-lightGray"
      >
        <View className="flex-1">
          <View className="flex-row items-center">
            <Body1>{sp.commonName}</Body1>
            {hasUnlabeled.has( sp.taxonId ) && (
              <View className="h-[8px] w-[8px] ml-2 rounded-full bg-inatGreen" />
            )}
          </View>
          <List2 className="italic">{sp.name}</List2>
          {detail && <Body3>{detail}</Body3>}
          {currentUser && seen && !seen.has( sp.taxonId ) && (
            <Body3 className="text-inatGreen">Not yet seen at research grade</Body3>
          )}
        </View>
      </View>
    </Pressable>
  );

  return (
    <ScrollView className="bg-white h-full px-5 pt-4" onTouchStart={noteActivity}>
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
      {listening && !current && (
        <Body3 className="mt-1">Listening…</Body3>
      )}

      <View className="h-6" />
      {heardList.length === 0 && <Body3 className="py-2">Nothing yet.</Body3>}
      {heardList.map( h => row(
        h.sp,
        `${h.count} ${h.count === 1
          ? "time"
          : "times"}, last ${formatISOTimestamp( h.lastHeard )}`,
      ) )}

      <View className="h-20" />
    </ScrollView>
  );
};

export default AudioId;
