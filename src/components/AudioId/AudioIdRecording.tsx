/* eslint-disable i18next/no-literal-string */
import { CachesDirectoryPath } from "@dr.pogodin/react-native-fs";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Body1, Body3, Button } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, { useState } from "react";
import Observation from "realmModels/Observation";
import ObservationSound from "realmModels/ObservationSound";
import useStore from "stores/useStore";
import * as uuid from "uuid";

import useAudioIdHistory from "./audioIdHistory";
import { AudioBirdId } from "./audioIdSession";
import ClipTrimmer, { useClipSpan } from "./ClipTrimmer";

// The Audio ID clip heard around an observation's time: trim it and add it
// to the observation.
const AudioIdRecording = ( ) => {
  const navigation = useNavigation( );
  const { params } = useRoute( );
  const { id, time } = params as { id: string; time: number };
  const clip = useAudioIdHistory( state => state.clips[id] );
  const updateClip = useAudioIdHistory( state => state.updateClip );
  const currentObservation = useStore( state => state.currentObservation );
  const observations = useStore( state => state.observations );
  const currentObservationIndex = useStore( state => state.currentObservationIndex );
  const updateObservations = useStore( state => state.updateObservations );
  const { span, trim, setTrim } = useClipSpan( id, clip?.time, true );
  const [error, setError] = useState<string | null>( null );

  const addToObservation = async ( ) => {
    if ( !span || !AudioBirdId ) return;
    try {
      // Sound.new moves the file, so it gets its own.
      const out = `${CachesDirectoryPath}/${uuid.v4( )}.m4a`;
      await AudioBirdId.trimClip( span.path, trim[0], trim[1], out );
      const obsSound = await ObservationSound.new( `file://${out}` );
      const updated = [...observations];
      updated[currentObservationIndex] = Observation
        .appendObsSounds( [obsSound], currentObservation );
      updateClip( id, { observationUuid: currentObservation?.uuid } );
      updateObservations( updated );
      navigation.goBack( );
    } catch ( e ) {
      setError( `Couldn't add the sound: ${( e as Error ).message}` );
    }
  };

  if ( !clip ) return <Body3 className="p-5">This clip is no longer saved.</Body3>;
  if ( error ) return <Body3 className="p-5">{error}</Body3>;
  if ( !span ) return null;

  return (
    <View className="bg-white h-full px-5 pt-4">
      <Body1>{clip.sp.commonName}</Body1>
      <Body3 className="mt-1">
        Drag the handles to set where the clip starts and ends, then add it.
      </Body3>
      <ClipTrimmer
        span={span}
        trim={trim}
        onTrimChange={setTrim}
        markerAt={( time - span.startMs ) / 1000}
      />
      <Button
        className="mt-4"
        level="focus"
        text="ADD TO OBSERVATION"
        onPress={addToObservation}
      />
    </View>
  );
};

export default AudioIdRecording;
