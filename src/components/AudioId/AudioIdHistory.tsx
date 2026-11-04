import { useNavigation, useRoute } from "@react-navigation/native";
import {
  Body1, Body3, INatIcon, INatIconButton, List2,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React from "react";
import { FlatList } from "react-native";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import Observation from "realmModels/Observation";
import { formatISOTimestamp } from "sharedHelpers/dateAndTime";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

import useAudioIdHistory, { isClipCorrect } from "./audioIdHistory";
import { useOpenTopSounds } from "./AudioIdSoundsLink";
import ClipPlayButton from "./ClipPlayButton";
import useCommonName from "./useCommonName";
import useEligibleClips from "./useEligibleClips";

const { useQuery } = RealmContext;

const TAG_SHADES = { true: "rgba(116, 172, 0, 0.2)", false: "rgba(155, 16, 16, 0.15)" };
const OBSERVED_SHADE = "rgba(116, 172, 0, 0.5)";

// Every time Audio ID heard one species, newest first.
const AudioIdHistory = ( ) => {
  const { t } = useTranslation( );
  const navigation = useNavigation( );
  const { params } = useRoute( );
  const { taxonId } = params as { taxonId: number };
  const clips = useAudioIdHistory( state => state.clips );
  const tagClip = useAudioIdHistory( state => state.tagClip );
  const deleteClip = useAudioIdHistory( state => state.deleteClip );
  const openTopSounds = useOpenTopSounds( );
  const ofSpecies = Object.values( clips )
    .filter( c => c.sp.taxonId === taxonId )
    .sort( ( a, b ) => b.time - a.time );
  const sp = ofSpecies[0]?.sp;
  const commonName = useCommonName( sp );
  // Clips whose observation is still saved on this device
  const obsUuids = ofSpecies.flatMap( c => ( c.observationUuid
    ? [c.observationUuid]
    : [] ) );
  const savedObs = useQuery( {
    type: Observation,
    query: observations => observations.filtered( "uuid IN $0", obsUuids ),
    keyPaths: ["uuid"],
  }, [obsUuids.join( )] );
  const eligible = useEligibleClips( ofSpecies );
  const savedUuids = new Set( savedObs.map( o => o.uuid ) );
  const clipShade = ( clip: typeof ofSpecies[number] ) => {
    if ( clip.observationUuid && savedUuids.has( clip.observationUuid ) ) return OBSERVED_SHADE;
    const correct = isClipCorrect( clip );
    return correct === undefined
      ? undefined
      : TAG_SHADES[`${correct}`];
  };

  const header = sp && (
    <View className="flex-row items-center mb-3">
      <Pressable
        accessibilityRole="link"
        accessibilityHint={t( "Opens-the-species-page" )}
        className="flex-1"
        onPress={( ) => navigation.navigate( "TaxonDetails", {
          id: taxonId, fromAudioId: true,
        } )}
      >
        <Body1 className="color-inatGreen underline">{commonName}</Body1>
        <List2 className="italic">{sp.name}</List2>
      </Pressable>
      <INatIconButton
        icon="sound-outline"
        color={colors.inatGreen}
        onPress={( ) => openTopSounds( {
          id: taxonId, name: sp.name, preferred_common_name: commonName,
        } )}
        accessibilityLabel={t( "Top-faved-sounds" )}
        accessibilityHint={t( "Opens-top-faved-sound-observations-in-Explore" )}
      />
    </View>
  );

  // Virtualized: rendering every clip row up front held the tap on the Audio ID
  // list ~600 ms before this screen appeared (slow_screen_transition).
  return (
    <FlatList
      className="bg-white h-full"
      contentContainerClassName="px-5 pt-4 pb-20"
      data={ofSpecies}
      keyExtractor={clip => clip.id}
      ListHeaderComponent={header}
      ListEmptyComponent={<Body3 className="py-2">{t( "No-clips-saved-yet" )}</Body3>}
      renderItem={( { item: clip } ) => (
        <Swipeable
          rightThreshold={40}
          onSwipeableOpen={( ) => deleteClip( clip.id )}
          renderRightActions={( ) => (
            <View className="bg-warningRed justify-center items-end px-5 w-full">
              <INatIcon name="trash-outline" color={colors.white} size={22} />
            </View>
          )}
          childrenContainerStyle={{ backgroundColor: colors.white }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityHint={t( "Opens-the-clips-details" )}
            className="flex-row items-center py-2 px-2 border-b border-lightGray"
            style={{ backgroundColor: clipShade( clip ) }}
            onPress={( ) => navigation.navigate( "AudioIdClip", { id: clip.id } )}
          >
            <View className="flex-1">
              <Body1>{formatISOTimestamp( clip.time )}</Body1>
              <Body3>
                {t( "X-percent-confidence", { count: Math.round( clip.confidence * 100 ) } )}
              </Body3>
            </View>
            {eligible.has( clip.id ) && (
              <INatIcon name="merge" color={colors.inatGreen} size={20} />
            )}
            <INatIconButton
              icon="check"
              color={colors.inatGreen}
              onPress={( ) => tagClip( clip.id, true )}
              accessibilityLabel={t( "Right--correct" )}
              accessibilityHint={t( "Tags-the-ID-as-right" )}
            />
            <INatIconButton
              icon="close"
              color={colors.warningRed}
              onPress={( ) => tagClip( clip.id, false )}
              accessibilityLabel={t( "Wrong--incorrect" )}
              accessibilityHint={t( "Tags-the-ID-as-wrong" )}
            />
            <ClipPlayButton clip={clip} />
          </Pressable>
        </Swipeable>
      )}
    />
  );
};

export default AudioIdHistory;
