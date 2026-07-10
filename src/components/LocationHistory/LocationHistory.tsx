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
import { Alert, FlatList } from "react-native";
import LocationHistoryPoint from "realmModels/LocationHistoryPoint";
import Observation from "realmModels/Observation";
import Photo from "realmModels/Photo";
import type { RealmObservation } from "realmModels/types";
import applyTrackedLocationToObservation from "sharedHelpers/applyTrackedLocationToPhotos";
import distanceInMeters from "sharedHelpers/geoDistance";
import {
  startLocationHistoryTracking,
  stopLocationHistoryTracking,
  useLocationHistoryTrackingEnabled,
} from "sharedHelpers/locationHistoryTracker";
import { useTranslation } from "sharedHooks";

const { useQuery, useRealm } = RealmContext;

// Photo location and tracked location are considered comparable only if
// they're within this many milliseconds of each other
const MAX_MATCH_GAP_MS = 12 * 60 * 60 * 1000;

const findNearestPoint = ( points: ArrayLike<LocationHistoryPoint>, targetMs: number ) => {
  if ( points.length === 0 ) return null;

  let lo = 0;
  let hi = points.length - 1;
  while ( lo < hi ) {
    const mid = Math.floor( ( lo + hi ) / 2 );
    if ( points[mid].recordedAt.getTime() < targetMs ) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  let best = points[lo];
  let bestGap = Math.abs( best.recordedAt.getTime() - targetMs );
  if ( lo > 0 ) {
    const prev = points[lo - 1];
    const prevGap = Math.abs( prev.recordedAt.getTime() - targetMs );
    if ( prevGap < bestGap ) {
      best = prev;
      bestGap = prevGap;
    }
  }

  return bestGap <= MAX_MATCH_GAP_MS
    ? best
    : null;
};

const PhotoLocationRow = ( { item }: { item: {
  uuid: string;
  observed_on: string | null;
  photoUri: string | null;
  distanceMeters: number | null;
}; } ) => {
  const { t } = useTranslation();

  return (
    <View className="flex-row items-center p-3 border-b border-lightGray">
      {item.photoUri && (
        <Image
          source={{ uri: item.photoUri }}
          className="w-16 h-16 rounded"
        />
      )}
      <View className="ml-3 flex-1">
        <Body2>{item.observed_on}</Body2>
        <List2>
          {item.distanceMeters === null
            ? t( "No-tracked-location-nearby" )
            : t( "Meters-Away", { meters: Math.round( item.distanceMeters ) } )}
        </List2>
      </View>
    </View>
  );
};

const LocationHistory = ( ) => {
  const { t } = useTranslation();
  const realm = useRealm();
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
          + "AND latitude != null AND longitude != null AND observed_on != nil",
        )
        .sorted( "observed_on", true ),
    },
    [],
  ) as unknown as RealmObservation[];

  const observationsMissingLocation = useQuery(
    {
      type: Observation,
      query: obsList => obsList
        .filtered(
          "( _deleted_at == nil OR _pending_deletion == false OR _pending_deletion == nil ) "
          + "AND ( latitude == nil OR longitude == nil ) AND observed_on != nil",
        ),
    },
    [],
  ) as unknown as RealmObservation[];

  const applicableObservations = useMemo( ( ) => observationsMissingLocation.filter( obs => {
    const targetMs = new Date( obs.observed_on ?? 0 ).getTime();
    return !!findNearestPoint( historyPoints, targetMs );
  } ), [observationsMissingLocation, historyPoints] );

  const photoComparisons = useMemo( ( ) => observations.map( obs => {
    const targetMs = new Date( obs.observed_on ?? 0 ).getTime();
    const nearestPoint = findNearestPoint( historyPoints, targetMs );
    const distanceMeters = nearestPoint && obs.latitude != null && obs.longitude != null
      ? distanceInMeters(
        obs.latitude,
        obs.longitude,
        nearestPoint.latitude,
        nearestPoint.longitude,
      )
      : null;

    return {
      uuid: obs.uuid,
      observed_on: obs.observed_on ?? null,
      photoUri: Photo.displayLocalOrRemoteSquarePhoto( photoFromObservation( obs ) ),
      distanceMeters,
    };
  } ), [observations, historyPoints] );

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
      const targetMs = new Date( obs.observed_on ?? 0 ).getTime();
      const nearestPoint = findNearestPoint( historyPoints, targetMs );
      if ( nearestPoint ) {
        // eslint-disable-next-line no-await-in-loop
        const applied = await applyTrackedLocationToObservation( realm, obs, {
          latitude: nearestPoint.latitude,
          longitude: nearestPoint.longitude,
          accuracy: nearestPoint.accuracy,
        } );
        if ( applied ) appliedCount += 1;
      }
    }
    setIsApplyingLocation( false );
    Alert.alert(
      t( "Location-Applied" ),
      t( "X-Photos-Updated-With-Tracked-Location", { count: appliedCount } ),
    );
  }, [applicableObservations, historyPoints, realm, t] );

  return (
    <ScreenShell>
      <FlatList
        data={photoComparisons}
        keyExtractor={item => item.uuid}
        renderItem={( { item } ) => <PhotoLocationRow item={item} />}
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
