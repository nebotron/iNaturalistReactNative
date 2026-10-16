/* eslint-disable i18next/no-literal-string */
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  Body1, Body3, INatIcon, INatIconButton, List2,
} from "components/SharedComponents";
import { Pressable, ScrollView, View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React from "react";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import Observation from "realmModels/Observation";
import { formatISOTimestamp } from "sharedHelpers/dateAndTime";
import colors from "styles/tailwindColors";

import useAudioIdHistory, { isClipCorrect } from "./audioIdHistory";
import AudioIdSoundsLink from "./AudioIdSoundsLink";
import ClipPlayButton from "./ClipPlayButton";

const { useQuery } = RealmContext;

const TAG_SHADES = { true: "rgba(116, 172, 0, 0.2)", false: "rgba(155, 16, 16, 0.15)" };
const OBSERVED_SHADE = "rgba(116, 172, 0, 0.5)";

// Every time Audio ID heard one species, newest first.
const AudioIdHistory = ( ) => {
  const navigation = useNavigation( );
  const { params } = useRoute( );
  const { taxonId } = params as { taxonId: number };
  const clips = useAudioIdHistory( state => state.clips );
  const tagClip = useAudioIdHistory( state => state.tagClip );
  const deleteClip = useAudioIdHistory( state => state.deleteClip );
  const ofSpecies = Object.values( clips )
    .filter( c => c.sp.taxonId === taxonId )
    .sort( ( a, b ) => b.time - a.time );
  const sp = ofSpecies[0]?.sp;
  // Clips whose observation is still saved on this device
  const obsUuids = ofSpecies.flatMap( c => ( c.observationUuid
    ? [c.observationUuid]
    : [] ) );
  const savedObs = useQuery( {
    type: Observation,
    query: observations => observations.filtered( "uuid IN $0", obsUuids ),
    keyPaths: ["uuid"],
  }, [obsUuids.join( )] );
  const savedUuids = new Set( savedObs.map( o => o.uuid ) );
  const clipShade = ( clip: typeof ofSpecies[number] ) => {
    if ( clip.observationUuid && savedUuids.has( clip.observationUuid ) ) return OBSERVED_SHADE;
    const correct = isClipCorrect( clip );
    return correct === undefined
      ? undefined
      : TAG_SHADES[`${correct}`];
  };

  return (
    <ScrollView className="bg-white h-full px-5 pt-4">
      {sp && (
        <View className="mb-3">
          <Body1>{sp.commonName}</Body1>
          <List2 className="italic">{sp.name}</List2>
        </View>
      )}
      <AudioIdSoundsLink taxonId={taxonId} />
      {ofSpecies.length === 0 && <Body3 className="py-2">No clips saved yet.</Body3>}
      {ofSpecies.map( clip => (
        <Swipeable
          key={clip.id}
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
            accessibilityHint="Opens the clip's details."
            className="flex-row items-center py-2 px-2 border-b border-lightGray"
            style={{ backgroundColor: clipShade( clip ) }}
            onPress={( ) => navigation.navigate( "AudioIdClip", { id: clip.id } )}
          >
            <View className="flex-1">
              <Body1>{formatISOTimestamp( clip.time )}</Body1>
              <Body3>{`${Math.round( clip.confidence * 100 )}% confidence`}</Body3>
            </View>
            <INatIconButton
              icon="check"
              color={colors.inatGreen}
              onPress={( ) => tagClip( clip.id, true )}
              accessibilityLabel="Right"
              accessibilityHint="Tags the ID as right."
            />
            <INatIconButton
              icon="close"
              color={colors.warningRed}
              onPress={( ) => tagClip( clip.id, false )}
              accessibilityLabel="Wrong"
              accessibilityHint="Tags the ID as wrong."
            />
            <ClipPlayButton id={clip.id} />
          </Pressable>
        </Swipeable>
      ) )}
      <View className="h-20" />
    </ScrollView>
  );
};

export default AudioIdHistory;
