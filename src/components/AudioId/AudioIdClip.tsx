/* eslint-disable i18next/no-literal-string */
import { CachesDirectoryPath, copyFile } from "@dr.pogodin/react-native-fs";
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  Body1, Body3, Button, Heading4, List2,
} from "components/SharedComponents";
import {
  Pressable, ScrollView, TextInput, View,
} from "components/styledComponents";
import React, { useState } from "react";
import Observation from "realmModels/Observation";
import { formatISONoTimezone } from "sharedHelpers/dateAndTime";
import { useTaxonSearch } from "sharedHooks";
import useStore from "stores/useStore";
import * as uuid from "uuid";

import { clipLabelText } from "./AudioIdHistory";
import useAudioIdHistory, { clipPath } from "./audioIdHistory";
import ClipPlayButton from "./ClipPlayButton";

// One Audio ID clip: play it, label what is in it, or make it an observation.
const AudioIdClip = ( ) => {
  const navigation = useNavigation( );
  const { params } = useRoute( );
  const { id } = params as { id: string };
  const clip = useAudioIdHistory( state => state.clips[id] );
  const labelClip = useAudioIdHistory( state => state.labelClip );
  const setObservations = useStore( state => state.setObservations );
  const [query, setQuery] = useState( "" );
  const { taxa } = useTaxonSearch( query );
  const [error, setError] = useState<string | null>( null );

  if ( !clip ) return <Body3 className="p-5">This clip is no longer saved.</Body3>;

  const createObservation = async ( ) => {
    try {
      // Sound.new moves the file, so hand it a copy to keep the clip here.
      const copy = `${CachesDirectoryPath}/${uuid.v4( )}.m4a`;
      await copyFile( clipPath( id ), copy );
      const observation = await Observation.createObsWithSoundPath( `file://${copy}` );
      observation.observed_on_string = formatISONoTimezone( new Date( clip.time ) );
      // The user's label wins over the model's ID; "no organism" leaves it blank.
      const { label, sp } = clip;
      if ( label?.taxonId ) {
        observation.taxon = { id: label.taxonId, name: label.name };
      } else if ( label?.taxonId !== null ) {
        observation.taxon = { id: sp.taxonId, name: sp.name, preferred_common_name: sp.commonName };
      }
      setObservations( [observation] );
      navigation.navigate( "ObsEdit" );
    } catch ( e ) {
      setError( `Couldn't create the observation: ${( e as Error ).message}` );
    }
  };

  return (
    <ScrollView className="bg-white h-full px-5 pt-4" keyboardShouldPersistTaps="handled">
      <View className="flex-row items-center">
        <View className="flex-1">
          <Body1>{clip.sp.commonName}</Body1>
          <List2 className="italic">{clip.sp.name}</List2>
          <Body3>{new Date( clip.time ).toLocaleString( )}</Body3>
          <Body3>{`${Math.round( clip.confidence * 100 )}% confidence`}</Body3>
        </View>
        <ClipPlayButton id={id} />
      </View>

      <Button
        className="mt-4"
        level="focus"
        text="CREATE OBSERVATION"
        onPress={createObservation}
      />
      {error && <Body3 className="mt-2 text-warningRed">{error}</Body3>}

      <Heading4 className="mt-6 mb-1">LABEL THIS CLIP</Heading4>
      <Body3 className="mb-2">{clipLabelText( clip.label ) || "Not labeled yet."}</Body3>
      <Button
        className="mb-2"
        level="neutral"
        text={`It's ${clip.sp.commonName}`}
        onPress={( ) => labelClip( id, clip.sp.taxonId, clip.sp.name )}
      />
      <Button
        className="mb-2"
        level="neutral"
        text="No organism"
        onPress={( ) => labelClip( id, null, null )}
      />
      <TextInput
        accessibilityLabel="Search for another organism"
        className="border border-lightGray rounded-lg px-3 py-2 mt-2"
        placeholder="Another organism…"
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
      />
      {query.length > 0 && taxa.map( taxon => (
        <Pressable
          key={taxon.id}
          accessibilityRole="button"
          accessibilityHint="Labels the clip as this organism."
          className="py-2 border-b border-lightGray"
          onPress={( ) => {
            labelClip( id, taxon.id, taxon.name || null );
            setQuery( "" );
          }}
        >
          <Body1>{taxon.preferred_common_name || taxon.name}</Body1>
          <List2 className="italic">{taxon.name}</List2>
        </Pressable>
      ) )}
      <View className="h-20" />
    </ScrollView>
  );
};

export default AudioIdClip;
