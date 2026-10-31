/* eslint-disable i18next/no-literal-string */
import { CachesDirectoryPath } from "@dr.pogodin/react-native-fs";
import { useNavigation, useRoute } from "@react-navigation/native";
import ObsListItem from "components/ObservationsFlashList/ObsListItem";
import {
  Body1, Body3, Button, List2, Map,
} from "components/SharedComponents";
import LocationIndicator from "components/SharedComponents/Map/LocationIndicator";
import { Pressable, ScrollView, View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useMemo, useState } from "react";
import LocationHistoryPoint from "realmModels/LocationHistoryPoint";
import Observation from "realmModels/Observation";
import ObservationSound from "realmModels/ObservationSound";
import { formatISONoTimezone, formatISOTimestamp } from "sharedHelpers/dateAndTime";
import {
  filterUsableTrackedPoints,
  interpolateFromUsablePoints,
  MAX_MATCH_GAP_MS,
} from "sharedHelpers/interpolateTrackedLocation";
import { useCurrentUser } from "sharedHooks";
import useStore from "stores/useStore";
import * as uuid from "uuid";

import useAudioIdHistory from "./audioIdHistory";
import { AudioBirdId } from "./audioIdSession";
import ClipTrimmer, { useClipSpan } from "./ClipTrimmer";

const { useQuery } = RealmContext;

// Observations of the same species within this long of the clip are offered to add it to.
const NEARBY_MS = 60 * 1000;
const obsTime = ( obs: Observation ) => Date
  .parse( obs.time_observed_at || obs.observed_on_string );
const formatDelta = ( ms: number ) => `${ms < 0
  ? "-"
  : "+"}${Math.round( Math.abs( ms ) / 1000 )}s`;

// One Audio ID clip: trim it and make it an observation.
const AudioIdClip = ( ) => {
  const navigation = useNavigation( );
  const { params } = useRoute( );
  const { id } = params as { id: string };
  const clip = useAudioIdHistory( state => state.clips[id] );
  const updateClip = useAudioIdHistory( state => state.updateClip );
  const setObservations = useStore( state => state.setObservations );
  const prepareObsEdit = useStore( state => state.prepareObsEdit );
  const updateObservations = useStore( state => state.updateObservations );
  const currentUser = useCurrentUser( );
  const [error, setError] = useState<string | null>( null );
  const { span, trim, setTrim } = useClipSpan( id, clip?.time, false, clip?.call );
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
  // Where location tracking put us when the clip was heard, else the fix taken then.
  const tracked = interpolateFromUsablePoints( usablePoints, time );
  const location = tracked || clip?.location;
  const day = formatISONoTimezone( new Date( time ) ).slice( 0, 10 );
  const sameDayObs = useQuery( {
    type: Observation,
    query: observations => observations.filtered(
      "observed_on_string BEGINSWITH $0 || time_observed_at BEGINSWITH $0 || observed_on == $0",
      day,
    ),
  }, [day] );
  // The user's label wins over the model's ID; "no organism" matches nothing.
  const taxonId = clip?.label?.taxonId
    || ( clip?.label?.taxonId === null
      ? null
      : clip?.sp.taxonId );
  const nearbyObs = sameDayObs
    .filter( obs => taxonId && obs.taxon?.id === taxonId
      && Math.abs( obsTime( obs ) - time ) <= NEARBY_MS )
    .sort( ( a, b ) => Math.abs( obsTime( a ) - time ) - Math.abs( obsTime( b ) - time ) );

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

  const addToObservation = async ( obs: Observation ) => {
    if ( !span || !AudioBirdId ) return;
    try {
      // Sound.new moves the file, so hand it a copy to keep the clip here.
      const out = `${CachesDirectoryPath}/${uuid.v4( )}.m4a`;
      await AudioBirdId.trimClip( span.path, trim[0], trim[1], out );
      const obsSound = await ObservationSound.new( `file://${out}` );
      prepareObsEdit( obs );
      const { currentObservation } = useStore.getState( );
      updateObservations( [Observation.appendObsSounds( [obsSound], currentObservation )] );
      updateClip( id, { observationUuid: obs.uuid } );
      navigation.navigate( "ObsEdit" );
    } catch ( e ) {
      setError( `Couldn't add the sound: ${( e as Error ).message}` );
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
          <View className="mt-4 h-[250px] rounded-lg overflow-hidden">
            <Map
              mapHeight={250}
              initialRegion={{
                latitude: location.latitude,
                longitude: location.longitude,
                latitudeDelta: 0.02,
                longitudeDelta: 0.02,
              }}
              mapChildren={(
                <LocationIndicator
                  latitude={location.latitude}
                  longitude={location.longitude}
                  positionalAccuracy={location.accuracy ?? undefined}
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
      {nearbyObs.length > 0 && (
        <Body1 className="mt-6">Add to observation</Body1>
      )}
      {nearbyObs.map( obs => (
        <Pressable
          key={obs.uuid}
          accessibilityRole="button"
          accessibilityHint="Adds the clip to this observation."
          className="-mx-5 justify-center"
          onPress={( ) => addToObservation( obs )}
        >
          <ObsListItem observation={obs} currentUser={currentUser} hideObsUploadStatus />
          <Body3 className="absolute right-5">
            {formatDelta( obsTime( obs ) - time )}
          </Body3>
        </Pressable>
      ) )}
      {error && <Body3 className="mt-2 text-warningRed">{error}</Body3>}

      <View className="h-20" />
    </ScrollView>
  );
};

export default AudioIdClip;
