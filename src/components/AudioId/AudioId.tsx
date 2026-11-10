import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { fetchSpeciesCounts } from "api/observations";
import { fetchTaxaBasics } from "api/taxa";
import {
  Body1, Body3, Button, IconicTaxonIcon, INatIcon,
} from "components/SharedComponents";
import CachedImage from "components/SharedComponents/CachedImage";
import { Pressable, ScrollView, View } from "components/styledComponents";
import i18n from "i18next";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback, useEffect, useMemo, useSyncExternalStore,
} from "react";
import { Trans } from "react-i18next";
import type { ViewProps } from "react-native";
import {
  AppState, Linking, Modal, requireNativeComponent,
} from "react-native";
import { UpdateMode } from "realm";
import Taxon from "realmModels/Taxon";
import type { RealmTaxon } from "realmModels/types";
import { formatISOTimestamp } from "sharedHelpers/dateAndTime";
import { holdKeepAwake, releaseKeepAwake } from "sharedHelpers/keepAwake";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import { getTunable } from "sharedHelpers/tunableParams";
import { useCurrentUser, useTranslation } from "sharedHooks";
import useAuthenticatedQuery from "sharedHooks/useAuthenticatedQuery";
import colors from "styles/tailwindColors";
import type { StoreApi, UseBoundStore } from "zustand";

import useAudioIdHistory from "./audioIdHistory";
import type { AudioIdSpecies } from "./audioIdModel";
import type { Heard } from "./audioIdSession";
import useAudioIdSession, {
  isHeard, noteActivity, noteScreenRender, startDimming, stopDimming, useScreenDimmed,
  useScreenPaused,
} from "./audioIdSession";
import useEligibleClips from "./useEligibleClips";

const { useRealm } = RealmContext;

// Animal classes the model covers, for asking which of them the user has seen.
const SEEN_TAXON_IDS = [
  3, // birds
  20978, // amphibians
  47158, // insects
  40151, // mammals
  26036, // reptiles
].join( "," );
const SEEN_MAX_PAGES = 10;
const RECENT_OBS_DAYS = getTunable( "audioIdRecentObsDays" );

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

interface TaxonExtras { url?: string; commonName?: string }

// Photo URLs and localized common names by taxon ID, from Realm. Taxa not
// there yet are fetched in batches and saved: a long heard list mounting a
// useTaxon per row fired dozens of full taxon fetches at once and got 429s
const PHOTO_BATCH_SIZE = 30;
// Fetched once per launch even if cached: a cached name can be stale, e.g. the
// model's English name saved with an Audio ID observation
const refreshedIds = new Set<number>( );
const useTaxonExtras = ( taxonIds: number[] ): Map<number, TaxonExtras> => {
  const realm = useRealm( );
  const local = new Map( taxonIds.map( id => [
    id, realm.objectForPrimaryKey<RealmTaxon>( "Taxon", id ),
  ] ) );
  // loadBirdCodes caches bird taxa without photos, so a name alone isn't enough
  const missing = taxonIds
    .filter( id => !refreshedIds.has( id )
      || !local.get( id )?.name || !local.get( id )?.default_photo?.url )
    .sort( ( a, b ) => a - b );
  const currentUser = useCurrentUser( );
  // Signed-in users get names per their account settings; otherwise use the app locale
  const locale = currentUser
    ? undefined
    : i18n?.language ?? "en";
  useAuthenticatedQuery(
    ["audioIdTaxa", missing.join( "," ), locale],
    async optsWithAuth => {
      for ( let i = 0; i < missing.length; i += PHOTO_BATCH_SIZE ) {
        // eslint-disable-next-line no-await-in-loop
        const results = await fetchTaxaBasics(
          missing.slice( i, i + PHOTO_BATCH_SIZE ),
          optsWithAuth,
          locale
            ? { locale }
            : {},
        );
        missing.slice( i, i + PHOTO_BATCH_SIZE ).forEach( id => refreshedIds.add( id ) );
        safeRealmWrite( realm, ( ) => ( results || [] ).forEach( ( t: Record<string, unknown> ) => {
          realm.create( "Taxon", Taxon.forUpdate( Taxon.mapApiToRealm( t ) ), UpdateMode.Modified );
        } ), "saving Audio ID taxa" );
      }
      return true;
    },
    { enabled: missing.length > 0, staleTime: Infinity },
  );
  return new Map( taxonIds.flatMap( id => {
    const taxon = local.get( id );
    return taxon?.name
      ? [[id, { url: taxon.default_photo?.url, commonName: taxon.preferred_common_name }]]
      : [];
  } ) );
};

const TaxonThumb = ( { url, onPress, children }: {
  url?: string; onPress: ( ) => void; children?: React.ReactNode;
} ) => {
  const { t } = useTranslation( );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={t( "Opens-the-species-page" )}
      className="w-[80px] h-[80px]"
      onPress={onPress}
    >
      {url
        ? <CachedImage source={{ uri: url }} className="w-full h-full" />
        : <IconicTaxonIcon imageClassName="w-full h-full" iconicTaxonName="Aves" />}
      <View pointerEvents="none" className="absolute bottom-[5px] right-[5px] flex-row">
        {children}
      </View>
    </Pressable>
  );
};

// A small round marker on a species photo; badges share a shape and differ by icon and color.
const ThumbBadge = ( { icon, className }: { icon: string; className: string } ) => (
  <View className={`ml-1 rounded-full p-[3px] border-2 border-white ${className}`}>
    <INatIcon name={icon} color={colors.white} size={12} />
  </View>
);

// Explains the badges on species photos
const BadgeKey = ( { showStar }: { showStar: boolean } ) => {
  const { t } = useTranslation( );
  return (
    <View className="mb-3">
      <View className="flex-row items-center">
        <ThumbBadge icon="plus-bold" className="bg-inatGreen" />
        <Body3 className="ml-2 flex-1">{t( "Has-a-clip-you-can-add-to-an-observation" )}</Body3>
      </View>
      {showStar && (
        <View className="flex-row items-center mt-1">
          <ThumbBadge icon="star" className="bg-warningYellow" />
          <Body3 className="ml-2 flex-1">{t( "Unobserved-by-me" )}</Body3>
        </View>
      )}
    </View>
  );
};

// The last 10 s of sound, Merlin-style: dark marks on a full-width white
// strip, low frequencies at the bottom. Drawn natively from the microphone
// audio.
const AudioSpectrogram = requireNativeComponent<ViewProps>( "AudioSpectrogram" );
const SPECTROGRAM_STYLE = { height: 140 };
// While dimmed the view is left out, so it stops drawing every frame; the
// native module keeps the audio, so it shows the last 10 s when it's back.
const Spectrogram = ( { paused }: { paused: boolean } ) => (
  <View className="mt-4 -mx-5 border-y border-lightGray">
    {paused
      ? <View style={SPECTROGRAM_STYLE} />
      : <AudioSpectrogram style={SPECTROGRAM_STYLE} />}
  </View>
);

// A store's value that stops re-rendering the screen while it's dimmed or
// out of sight (see useScreenPaused), so the runs coming in every second
// don't redraw a screen nobody can see. Showing it again subscribes again,
// which picks up the live value. The selector must return a value already in
// the store, not a new object.
const useWhileBright = <S, T>(
  useStore: UseBoundStore<StoreApi<S>>,
  selector: ( state: S ) => T,
): T => {
  const paused = useScreenPaused( );
  const subscribe = useCallback( ( onChange: ( ) => void ) => ( paused
    ? ( ) => undefined
    : useStore.subscribe( onChange ) ), [useStore, paused] );
  return useSyncExternalStore( subscribe, ( ) => selector( useStore.getState( ) ) );
};

const AudioId = ( ) => {
  noteScreenRender( );
  const { t } = useTranslation( );
  const navigation = useNavigation( );
  // Keep the display awake while this screen is focused
  useFocusEffect( useCallback( ( ) => {
    holdKeepAwake( "audioId" );
    startDimming( );
    const subscription = AppState.addEventListener( "change", state => {
      if ( state === "active" ) startDimming( );
    } );
    return ( ) => {
      subscription.remove( );
      stopDimming( );
      releaseKeepAwake( "audioId" );
    };
  }, [] ) );
  const {
    listening, error, current, setup, setSeen, start,
    stop,
  } = useWhileBright( useAudioIdSession, state => state );
  const dimmed = useScreenDimmed( );
  const species = useMemo( ( ) => setup?.species || [], [setup] );
  const currentUser = useCurrentUser( );
  const seen = useSeenTaxonIds( currentUser?.id );
  const recentSince = new Date( Date.now( ) - RECENT_OBS_DAYS * 86400000 )
    .toISOString( ).slice( 0, 10 );
  const recent = useSeenTaxonIds( currentUser?.id, recentSince );
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
  const hearingNow = ( taxonId: number ) => listening && isHeard( scoreNow( taxonId ) );
  const clips = useWhileBright( useAudioIdHistory, state => state.clips );
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
  const taxonExtras = useTaxonExtras( useMemo(
    ( ) => heardList.map( h => h.sp.taxonId ),
    [heardList],
  ) );
  const clipList = useMemo( ( ) => Object.values( clips ), [clips] );
  const eligible = useEligibleClips( clipList );
  // Species with a clip that could still go on an observation and hasn't been labeled
  const canAdd = new Set( clipList
    .filter( c => eligible.has( c.id ) && !c.label ).map( c => c.sp.taxonId ) );

  const openTaxon = ( taxonId: number ) => navigation.navigate( "TaxonDetails", {
    id: taxonId, fromAudioId: true,
  } );

  // Species being heard right now are highlighted in yellow.
  const row = ( sp: AudioIdSpecies, lastHeard: number ) => (
    <Pressable
      key={sp.taxonId}
      accessibilityRole="button"
      accessibilityHint={t( "Opens-the-history-of-when-this-species-was-heard" )}
      className={`flex-row items-center -ml-5 h-[80px] ${
        hearingNow( sp.taxonId )
          ? "bg-yellow"
          : ""}`}
      onPress={( ) => navigation.navigate( "AudioIdHistory", { taxonId: sp.taxonId } )}
    >
      <TaxonThumb
        url={taxonExtras.get( sp.taxonId )?.url}
        onPress={( ) => openTaxon( sp.taxonId )}
      >
        {canAdd.has( sp.taxonId ) && <ThumbBadge icon="plus-bold" className="bg-inatGreen" />}
        {currentUser && seen && !seen.has( sp.taxonId ) && (
          <ThumbBadge icon="star" className="bg-warningYellow" />
        )}
      </TaxonThumb>
      <View
        className="flex-1 flex-row items-center self-stretch ml-3 pr-2 border-b border-lightGray"
      >
        <View className="flex-1">
          <Body1 numberOfLines={1}>
            {/* The model's English name until the localized one loads */}
            {taxonExtras.get( sp.taxonId )?.commonName || sp.commonName}
          </Body1>
          <Body3 className="mt-1 text-darkGrayDisabled">
            {t( "Last-heard-time", { time: formatISOTimestamp( lastHeard ) } )}
          </Body3>
        </View>
      </View>
    </Pressable>
  );

  return (
    // Claiming the touch when dimmed keeps it from also pressing anything
    <View className="flex-1" onStartShouldSetResponderCapture={noteActivity}>
      <ScrollView className="bg-white h-full px-5 pt-4">
        <BadgeKey showStar={!!currentUser} />
        <Body3 className="mb-3">
          {setup
            ? (
              <Trans
                i18nKey="Audio-ID-identifies-X-animals-by-sound-using-BirdNET"
                values={{ count: species.length }}
                components={[
                  <Body3
                    key="0"
                    accessibilityRole="link"
                    accessibilityHint={t( "Opens-a-searchable-list-of-the-species-it-listens-for" )}
                    className="underline"
                    onPress={( ) => navigation.navigate( "AudioIdTaxa" )}
                  />,
                  <Body3
                    key="1"
                    accessibilityRole="link"
                    accessibilityHint={t( "Opens-the-BirdNET-website" )}
                    className="underline"
                    onPress={( ) => Linking.openURL( "https://birdnet.cornell.edu" )}
                  />,
                ]}
              />
            )
            : (
              <Trans
                i18nKey="Audio-ID-identifies-animals-by-sound-using-BirdNET"
                components={[
                  <Body3
                    key="0"
                    accessibilityRole="link"
                    accessibilityHint={t( "Opens-the-BirdNET-website" )}
                    className="underline"
                    onPress={( ) => Linking.openURL( "https://birdnet.cornell.edu" )}
                  />,
                ]}
              />
            )}
        </Body3>
        <Button
          level={listening
            ? "warning"
            : "focus"}
          text={listening
            ? t( "STOP-LISTENING" )
            : t( "START-LISTENING" )}
          onPress={listening
            ? stop
            : start}
        />
        {error && <Body3 className="mt-2 text-warningRed">{error}</Body3>}
        {listening && <Spectrogram paused={dimmed} />}
        {listening && !current && (
          <Body3 className="mt-1">{t( "Listening" )}</Body3>
        )}

        <View className="h-6" />
        {heardList.length === 0 && <Body3 className="py-2">{t( "Nothing-heard-yet" )}</Body3>}
        {heardList.map( h => row( h.sp, h.lastHeard ) )}

        <View className="h-20" />
      </ScrollView>
      {/* Covers the header and tab bar too; a touch only wakes it */}
      <Modal transparent visible={dimmed} animationType="fade">
        <Pressable
          accessibilityRole="button"
          accessibilityHint={t( "Brightens-the-screen" )}
          className="flex-1 bg-black/95"
          onPress={noteActivity}
        />
      </Modal>
    </View>
  );
};

export default AudioId;
