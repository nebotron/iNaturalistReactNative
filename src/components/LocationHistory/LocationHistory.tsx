import { useNavigation } from "@react-navigation/native";
import { photoFromObservation } from "components/ObservationsFlashList/util";
import {
  Body2,
  Button,
  List2,
  SwitchRow,
} from "components/SharedComponents";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import { Image, View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback, useMemo, useState,
} from "react";
import { Alert, FlatList, Pressable } from "react-native";
import LocationHistoryPoint from "realmModels/LocationHistoryPoint";
import Observation from "realmModels/Observation";
import Photo from "realmModels/Photo";
import type { RealmObservation } from "realmModels/types";
import applyTrackedLocationToObservation from "sharedHelpers/applyTrackedLocationToPhotos";
import distanceInMeters from "sharedHelpers/geoDistance";
import {
  filterUsableTrackedPoints,
  interpolateFromUsablePoints,
} from "sharedHelpers/interpolateTrackedLocation";
import {
  startLocationHistoryTracking,
  stopLocationHistoryTracking,
  useLocationHistoryTrackingEnabled,
} from "sharedHelpers/locationHistoryTracker";
import { useTranslation } from "sharedHooks";

const { useQuery, useRealm } = RealmContext;

// observed_on is only populated once an observation has round-tripped
// through the server; newly-created, not-yet-synced observations only have
// observed_on_string set, so it must be used as a fallback everywhere we
// need an observation's date.
const getObservedOnMs = ( obs: RealmObservation ) => new Date(
  obs.observed_on_string ?? obs.observed_on ?? 0,
).getTime();

const PhotoLocationRow = ( { item, onPress, onPhotoPress }: { item: {
  uuid: string;
  observed_on: string | null;
  photoUri: string | null;
  distanceMeters: number | null;
  hasPhotoLocation: boolean;
  hasTrackedLocation: boolean;
}; onPress?: () => void; onPhotoPress?: () => void; } ) => {
  const { t } = useTranslation();

  let statusText: string;
  if ( !item.hasPhotoLocation && !item.hasTrackedLocation ) {
    statusText = t( "Missing-photo-and-tracked-location" );
  } else if ( !item.hasPhotoLocation ) {
    statusText = t( "Missing-photo-location" );
  } else if ( !item.hasTrackedLocation ) {
    statusText = t( "No-tracked-location-nearby" );
  } else {
    statusText = t( "Meters-Away", { meters: Math.round( item.distanceMeters as number ) } );
  }

  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={!onPress}>
      <View className="flex-row items-center p-3 border-b border-lightGray">
        {item.photoUri && (
          <Pressable
            accessibilityRole="button"
            onPress={onPhotoPress}
            disabled={!onPhotoPress}
          >
            <Image
              source={{ uri: item.photoUri }}
              className="w-16 h-16 rounded"
            />
          </Pressable>
        )}
        <View className="ml-3 flex-1">
          <Body2>{item.observed_on}</Body2>
          <List2>{statusText}</List2>
          <View className="flex-row items-center mt-1">
            <View
              className={`w-2.5 h-2.5 rounded-full mr-1.5 ${
                item.hasPhotoLocation
                  ? "bg-inatGreen"
                  : "bg-warningRed"
              }`}
            />
            <List2 className="mr-3">{t( "Photo-location" )}</List2>
            <View
              className={`w-2.5 h-2.5 rounded-full mr-1.5 ${
                item.hasTrackedLocation
                  ? "bg-blue"
                  : "bg-warningRed"
              }`}
            />
            <List2>{t( "Tracked-location" )}</List2>
          </View>
        </View>
      </View>
    </Pressable>
  );
};

const LocationHistory = ( ) => {
  const { t } = useTranslation();
  const realm = useRealm();
  const navigation = useNavigation();
  const [trackingEnabled] = useLocationHistoryTrackingEnabled();
  const [isApplyingLocation, setIsApplyingLocation] = useState( false );

  const historyPoints = useQuery(
    {
      type: LocationHistoryPoint,
      query: points => points.sorted( "recordedAt" ),
    },
    [],
  );

  const observations = useQuery(
    {
      type: Observation,
      query: obsList => obsList
        .filtered(
          "( _deleted_at == nil OR _pending_deletion == false OR _pending_deletion == nil ) "
          + "AND latitude != null AND longitude != null "
          + "AND ( observed_on != nil OR observed_on_string != nil )",
        ),
    },
    [],
  ) as unknown as RealmObservation[];

  const observationsMissingLocation = useQuery(
    {
      type: Observation,
      query: obsList => obsList
        .filtered(
          "( _deleted_at == nil OR _pending_deletion == false OR _pending_deletion == nil ) "
          + "AND ( latitude == nil OR longitude == nil ) "
          + "AND ( observed_on != nil OR observed_on_string != nil )",
        ),
    },
    [],
  ) as unknown as RealmObservation[];

  // Accuracy-filtering the tracked points is O(n) in the number of recorded
  // points, so it's done once here and reused for every observation below,
  // rather than re-filtering the full history on every lookup.
  const usableHistoryPoints = useMemo(
    ( ) => filterUsableTrackedPoints( historyPoints ),
    [historyPoints],
  );

  const applicableObservations = useMemo( ( ) => observationsMissingLocation.filter( obs => {
    const targetMs = getObservedOnMs( obs );
    return !!interpolateFromUsablePoints( usableHistoryPoints, targetMs );
  } ), [observationsMissingLocation, usableHistoryPoints] );

  const photoComparisons = useMemo(
    ( ) => [
      ...observations,
      ...observationsMissingLocation,
    ].map( obs => {
      const targetMs = getObservedOnMs( obs );
      const trackedLocation = interpolateFromUsablePoints( usableHistoryPoints, targetMs );
      const hasPhotoLocation = obs.latitude != null && obs.longitude != null;
      const hasTrackedLocation = !!trackedLocation;
      const distanceMeters = trackedLocation && hasPhotoLocation
        ? distanceInMeters(
          obs.latitude,
          obs.longitude,
          trackedLocation.latitude,
          trackedLocation.longitude,
        )
        : null;

      return {
        uuid: obs.uuid,
        observed_on: obs.observed_on_string ?? obs.observed_on ?? null,
        photoUri: Photo.displayLocalOrRemoteSquarePhoto( photoFromObservation( obs ) ),
        distanceMeters,
        targetMs,
        hasPhotoLocation,
        hasTrackedLocation,
        observationLat: obs.latitude,
        observationLng: obs.longitude,
        trackedLat: trackedLocation?.latitude,
        trackedLng: trackedLocation?.longitude,
      };
    } ).sort( ( a, b ) => b.targetMs - a.targetMs ),
    [observations, observationsMissingLocation, usableHistoryPoints],
  );

  const handleToggleTracking = useCallback( async ( newValue: boolean ) => {
    if ( newValue ) {
      const result = await startLocationHistoryTracking();
      if ( !result.success ) {
        const description = t( "Enable-location-access-to-track-your-location-in-the-background" );
        const message = result.reason
          ? `${description}\n\n${result.reason}`
          : description;
        Alert.alert( t( "Location-Permission-Required" ), message );
      }
    } else {
      await stopLocationHistoryTracking();
    }
  }, [t] );

  const handleApplyLocation = useCallback( async ( ) => {
    setIsApplyingLocation( true );
    let appliedCount = 0;
    for ( const obs of applicableObservations ) {
      const targetMs = getObservedOnMs( obs );
      const trackedLocation = interpolateFromUsablePoints( usableHistoryPoints, targetMs );
      if ( trackedLocation ) {
        // eslint-disable-next-line no-await-in-loop
        const applied = await applyTrackedLocationToObservation( realm, obs, {
          latitude: trackedLocation.latitude,
          longitude: trackedLocation.longitude,
          accuracy: trackedLocation.accuracy,
        } );
        if ( applied ) appliedCount += 1;
      }
    }
    setIsApplyingLocation( false );
    Alert.alert(
      t( "Location-Applied" ),
      t( "X-Photos-Updated-With-Tracked-Location", { count: appliedCount } ),
    );
  }, [applicableObservations, usableHistoryPoints, realm, t] );

  const handlePhotoLocationPress = useCallback( item => {
    if ( item.observationLat != null && item.observationLng != null ) {
      navigation.navigate( "LocationHistoryDetailMap", {
        uuid: item.uuid,
        observationLat: item.observationLat,
        observationLng: item.observationLng,
        trackedLat: item.trackedLat || item.observationLat,
        trackedLng: item.trackedLng || item.observationLng,
        observationDate: item.observed_on || "",
        distanceMeters: item.distanceMeters,
      } );
    }
  }, [navigation] );

  const handlePhotoPress = useCallback( item => {
    navigation.navigate( "ObsDetails", { uuid: item.uuid } );
  }, [navigation] );

  return (
    <ScreenShell>
      <FlatList
        data={photoComparisons}
        keyExtractor={item => item.uuid}
        renderItem={( { item } ) => (
          <PhotoLocationRow
            item={item}
            onPress={item.hasPhotoLocation
              ? () => handlePhotoLocationPress( item )
              : undefined}
            onPhotoPress={() => handlePhotoPress( item )}
          />
        )}
        ListHeaderComponent={(
          <View className="p-4 border-b border-lightGray">
            <SwitchRow
              classNames="mb-3"
              label={t( "Track-location-in-the-background" )}
              onValueChange={handleToggleTracking}
              testID="LocationHistory.TrackingSwitch"
              value={!!trackingEnabled}
            />
            <Body2 className="text-darkGray mb-3">
              {t( "Location-history-lets-you-compare-photos-to-your-tracked-location" )}
            </Body2>
            <List2 className="mb-3">
              {t( "X-Location-Points-Recorded", { count: historyPoints.length } )}
            </List2>
            {historyPoints.length > 0 && (
              <Button
                className="mb-3"
                text={t( "View-all-location-points" )}
                onPress={( ) => navigation.navigate( "LocationHistoryPointsMap" )}
                testID="LocationHistory.ViewPointsButton"
              />
            )}
            {applicableObservations.length > 0 && (
              <Button
                text={t(
                  "Apply-Tracked-Location-to-X-Photos",
                  { count: applicableObservations.length },
                )}
                onPress={handleApplyLocation}
                loading={isApplyingLocation}
                disabled={isApplyingLocation}
                level="focus"
                testID="LocationHistory.ApplyLocationButton"
              />
            )}
          </View>
        )}
        ListEmptyComponent={(
          <View className="p-4">
            <Body2>{t( "No-photos-with-location-data-yet" )}</Body2>
          </View>
        )}
      />
    </ScreenShell>
  );
};

export default LocationHistory;
