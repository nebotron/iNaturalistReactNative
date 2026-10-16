/* eslint-disable i18next/no-literal-string */
import { CachesDirectoryPath, copyFile } from "@dr.pogodin/react-native-fs";
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  Body1, Body3, Button, List2, Map,
} from "components/SharedComponents";
import LocationIndicator from "components/SharedComponents/Map/LocationIndicator";
import { ScrollView, View } from "components/styledComponents";
import React, { useState } from "react";
import Observation from "realmModels/Observation";
import { formatISONoTimezone, formatISOTimestamp } from "sharedHelpers/dateAndTime";
import useStore from "stores/useStore";
import * as uuid from "uuid";

import useAudioIdHistory, { clipPath } from "./audioIdHistory";
import ClipPlayButton from "./ClipPlayButton";

// One Audio ID clip: play it or make it an observation.
const AudioIdClip = ( ) => {
  const navigation = useNavigation( );
  const { params } = useRoute( );
  const { id } = params as { id: string };
  const clip = useAudioIdHistory( state => state.clips[id] );
  const updateClip = useAudioIdHistory( state => state.updateClip );
  const setObservations = useStore( state => state.setObservations );
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
      updateClip( id, { observationUuid: observation.uuid } );
      setObservations( [observation] );
      navigation.navigate( "ObsEdit" );
    } catch ( e ) {
      setError( `Couldn't create the observation: ${( e as Error ).message}` );
    }
  };

  return (
    <ScrollView className="bg-white h-full px-5 pt-4">
      <View className="flex-row items-center">
        <View className="flex-1">
          <Body1>{clip.sp.commonName}</Body1>
          <List2 className="italic">{clip.sp.name}</List2>
          <Body3>{formatISOTimestamp( clip.time )}</Body3>
          <Body3>{`${Math.round( clip.confidence * 100 )}% confidence`}</Body3>
        </View>
        <ClipPlayButton id={id} />
      </View>

      {clip.location
        ? (
          <View className="mt-4 rounded-lg overflow-hidden">
            <Map
              mapHeight={250}
              initialRegion={{
                latitude: clip.location.latitude,
                longitude: clip.location.longitude,
                latitudeDelta: 0.02,
                longitudeDelta: 0.02,
              }}
              mapChildren={(
                <LocationIndicator
                  latitude={clip.location.latitude}
                  longitude={clip.location.longitude}
                  positionalAccuracy={clip.location.accuracy}
                />
              )}
            />
          </View>
        )
        : <Body3 className="mt-4">No location was recorded for this clip.</Body3>}

      <Button
        className="mt-4"
        level="focus"
        text="CREATE OBSERVATION"
        onPress={createObservation}
      />
      {error && <Body3 className="mt-2 text-warningRed">{error}</Body3>}

      <View className="h-20" />
    </ScrollView>
  );
};

export default AudioIdClip;
