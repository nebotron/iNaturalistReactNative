/* eslint-disable i18next/no-literal-string */
import { CachesDirectoryPath } from "@dr.pogodin/react-native-fs";
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  Body1, Body3, Button, List2, Map,
} from "components/SharedComponents";
import LocationIndicator from "components/SharedComponents/Map/LocationIndicator";
import { ScrollView, View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useMemo, useState } from "react";
import { Polyline } from "react-native-maps";
import LocationHistoryPoint from "realmModels/LocationHistoryPoint";
import Observation from "realmModels/Observation";
import { formatISONoTimezone, formatISOTimestamp } from "sharedHelpers/dateAndTime";
import {
  filterUsableTrackedPoints,
  interpolateFromUsablePoints,
  MAX_MATCH_GAP_MS,
} from "sharedHelpers/interpolateTrackedLocation";
import useStore from "stores/useStore";
import colors from "styles/tailwindColors";
import * as uuid from "uuid";

import useAudioIdHistory from "./audioIdHistory";
import { AudioBirdId } from "./audioIdSession";
import ClipTrimmer, { useClipSpan } from "./ClipTrimmer";

const { useQuery } = RealmContext;

// How much of the tracked path around the clip to draw.
const TRACK_WINDOW_MS = 15 * 60 * 1000;

// One Audio ID clip: trim it and make it an observation.
const AudioIdClip = ( ) => {
  const navigation = useNavigation( );
  const { params } = useRoute( );
  const { id } = params as { id: string };
  const clip = useAudioIdHistory( state => state.clips[id] );
  const updateClip = useAudioIdHistory( state => state.updateClip );
  const setObservations = useStore( state => state.setObservations );
  const [error, setError] = useState<string | null>( null );
  const { span, trim, setTrim } = useClipSpan( id, clip?.time, false );
  const time = clip?.time ?? 0;
  const trackPoints = useQuery(
    {
      type: LocationHistoryPoint,
      query: points => points
        .filtered(
          "recordedAt >= $0 && recordedAt <= $1",
          // Tracking only logs a fix after moving, so look as far as it matches.
          new Date( time - MAX_MATCH_GAP_MS ),
          new Date( time + MAX_MATCH_GAP_MS ),
        )
        .sorted( "recordedAt" ),
    },
    [time],
  );
  const usablePoints = useMemo( ( ) => filterUsableTrackedPoints( trackPoints ), [trackPoints] );
  const pathPoints = usablePoints
    .filter( p => Math.abs( p.recordedAt.getTime( ) - time ) <= TRACK_WINDOW_MS );
  // Where location tracking put us when the clip was heard, else the fix taken then.
  const tracked = interpolateFromUsablePoints( usablePoints, time );
  const location = tracked || clip?.location;

  if ( !clip ) return <Body3 className="p-5">This clip is no longer saved.</Body3>;

  const createObservation = async ( ) => {
    if ( !span || !AudioBirdId ) return;
    try {
      // Sound.new moves the file, so hand it a copy to keep the clip here.
      const out = `${CachesDirectoryPath}/${uuid.v4( )}.m4a`;
      await AudioBirdId.trimClip( span.path, trim[0], trim[1], out );
      const observation = await Observation.createObsWithSoundPath( `file://${out}` );
      observation.observed_on_string = formatISONoTimezone( new Date( clip.time ) );
      if ( location ) {
        observation.latitude = location.latitude;
        observation.longitude = location.longitude;
        observation.positional_accuracy = location.accuracy;
      }
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
      <Body1>{clip.sp.commonName}</Body1>
      <List2 className="italic">{clip.sp.name}</List2>
      <Body3>{formatISOTimestamp( clip.time )}</Body3>
      <Body3>{`${Math.round( clip.confidence * 100 )}% confidence`}</Body3>
      {span && <ClipTrimmer span={span} trim={trim} onTrimChange={setTrim} />}

      {location
        ? (
          <View className="mt-4 rounded-lg overflow-hidden">
            <Map
              mapHeight={250}
              initialRegion={{
                latitude: location.latitude,
                longitude: location.longitude,
                latitudeDelta: 0.02,
                longitudeDelta: 0.02,
              }}
              mapChildren={(
                <>
                  {pathPoints.length > 1 && (
                    <Polyline
                      coordinates={pathPoints.map( p => ( {
                        latitude: p.latitude, longitude: p.longitude,
                      } ) )}
                      strokeColor={colors.inatGreen}
                      strokeWidth={3}
                    />
                  )}
                  <LocationIndicator
                    latitude={location.latitude}
                    longitude={location.longitude}
                    positionalAccuracy={location.accuracy ?? undefined}
                  />
                </>
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
