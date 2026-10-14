/* eslint-disable i18next/no-literal-string */
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  Body1, Body3, List2,
} from "components/SharedComponents";
import { Pressable, ScrollView, View } from "components/styledComponents";
import React from "react";

import useAudioIdHistory from "./audioIdHistory";
import ClipPlayButton from "./ClipPlayButton";

export const clipLabelText = ( label?: { taxonId: number | null; name: string | null } ) => {
  if ( !label ) return null;
  return label.taxonId === null
    ? "Labeled: no organism"
    : `Labeled: ${label.name}`;
};

// Every time Audio ID heard one species, newest first.
const AudioIdHistory = ( ) => {
  const navigation = useNavigation( );
  const { params } = useRoute( );
  const { taxonId } = params as { taxonId: number };
  const clips = useAudioIdHistory( state => state.clips );
  const ofSpecies = Object.values( clips )
    .filter( c => c.sp.taxonId === taxonId )
    .sort( ( a, b ) => b.time - a.time );
  const sp = ofSpecies[0]?.sp;

  return (
    <ScrollView className="bg-white h-full px-5 pt-4">
      {sp && (
        <View className="mb-3">
          <Body1>{sp.commonName}</Body1>
          <List2 className="italic">{sp.name}</List2>
        </View>
      )}
      {ofSpecies.length === 0 && <Body3 className="py-2">No clips saved yet.</Body3>}
      {ofSpecies.map( clip => (
        <Pressable
          key={clip.id}
          accessibilityRole="button"
          accessibilityHint="Opens the clip's details."
          className="flex-row items-center py-2 border-b border-lightGray"
          onPress={( ) => navigation.navigate( "AudioIdClip", { id: clip.id } )}
        >
          <View className="flex-1">
            <Body1>{new Date( clip.time ).toLocaleString( )}</Body1>
            <Body3>{`${Math.round( clip.confidence * 100 )}% confidence`}</Body3>
            {clip.label && <Body3 className="text-inatGreen">{clipLabelText( clip.label )}</Body3>}
          </View>
          <ClipPlayButton id={clip.id} />
        </Pressable>
      ) )}
      <View className="h-20" />
    </ScrollView>
  );
};

export default AudioIdHistory;
