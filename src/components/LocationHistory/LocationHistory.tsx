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
  startLocationHistoryTracking,
  stopLocationHistoryTracking,
  useLocationHistoryTrackingEnabled,
} from "sharedHelpers/locationHistoryTracker";
import { useTranslation } from "sharedHooks";

const { useQuery, useRealm } = RealmContext;

// Photo location and tracked location are considered comparable only if
// they're within this many milliseconds of each other
const MAX_MATCH_GAP_MS = 12 * 60 * 60 * 1000;

// observed_on is only populated once an observation has round-tripped
// through the server; newly-created, not-yet-synced observations only have
// observed_on_string set, so it must be used as a fallback everywhere we
// need an observation's date.
const getObservedOnMs = ( obs: RealmObservation ) => new Date(
  obs.observed_on_string ?? obs.observed_on ?? 0,
).getTime();

interface InterpolatedLocation {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

const toLocation = ( point: LocationHistoryPoint ): InterpolatedLocation => ( {
  latitude: point.latitude,
  longitude: point.longitude,
  accuracy: point.accuracy,
} );

// Finds the first index whose recordedAt is >= targetMs (or points.length if none)
const upperBound = ( points: ArrayLike<LocationHistoryPoint>, targetMs: number ) => {
  let lo = 0;
  let hi = points.length;
  while ( lo < hi ) {
    const mid = Math.floor( ( lo + hi ) / 2 );
    if ( points[mid].recordedAt.getTime() < targetMs ) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
};

// Linearly interpolates between the two tracked points bracketing targetMs,
// falling back to the single closest point when targetMs is outside the
// tracked range entirely.
const findInterpolatedLocation = (
  points: ArrayLike<LocationHistoryPoint>,
  targetMs: number,
): InterpolatedLocation | null => {
  if ( points.length === 0 ) return null;

  const idx = upperBound( points, targetMs );
  const next = idx < points.length ? points[idx] : null;
  const prev = idx > 0 ? points[idx - 1] : null;

  if ( !prev && !next ) return null;

  if ( !prev ) {
    const gap = ( next as LocationHistoryPoint ).recordedAt.getTime() - targetMs;
    return gap <= MAX_MATCH_GAP_MS ? toLocation( next as LocationHistoryPoint ) : null;
  }

  if ( !next ) {
    const gap = targetMs - prev.recordedAt.getTime();
    return gap <= MAX_MATCH_GAP_MS ? toLocation( prev ) : null;
  }

  const prevMs = prev.recordedAt.getTime();
  const nextMs = next.recordedAt.getTime();
  if ( prevMs === targetMs ) return toLocation( prev );

  const minGap = Math.min( targetMs - prevMs, nextMs - targetMs );
  if ( minGap > MAX_MATCH_GAP_MS ) return null;

  const weight = ( targetMs - prevMs ) / ( nextMs - prevMs );
  return {
    latitude: prev.latitude + weight * ( next.latitude - prev.latitude ),
    longitude: prev.longitude + weight * ( next.longitude - prev.longitude ),
    accuracy: Math.max( prev.accuracy ?? 0, next.accuracy ?? 0 ) || null,
  };
};

const PhotoLocationRow = ( { item, onPress }: { item: {
  uuid: string;
  observed_on: string | null;
  photoUri: string | null;
  distanceMeters: number | null;
  hasPhotoLocation: boolean;
  hasTrackedLocation: boolean;
}; onPress?: () => void; } ) => {
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
    <Pressable onPress={onPress} disabled={!onPress}>
      <View className="flex-row items-center p-3 border-b border-lightGray">
        {item.photoUri && (
          <Image
            source={{ uri: item.photoUri }}
            className="w-16 h-16 rounded"
          />
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

  const applicableObservations = useMemo( ( ) => observationsMissingLocation.filter( obs => {
    const targetMs = getObservedOnMs( obs );
    return !!findInterpolatedLocation( historyPoints, targetMs );
  } ), [observationsMissingLocation, historyPoints] );

  const photoComparisons = useMemo( ( ) => [
    ...observations,
    ...observationsMissingLocation,
  ].map( obs => {
    const targetMs = getObservedOnMs( obs );
    const trackedLocation = findInterpolatedLocation( historyPoints, targetMs );
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
  [observations, observationsMissingLocation, historyPoints] );

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
      const trackedLocation = findInterpolatedLocation( historyPoints, targetMs );
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
  }, [applicableObservations, historyPoints, realm, t] );

  const handlePhotoLocationPress = useCallback( ( item ) => {
    if ( item.observationLat != null && item.observationLng != null ) {
      navigation.navigate( "LocationHistoryDetailMap", {
        observationLat: item.observationLat,
        observationLng: item.observationLng,
        trackedLat: item.trackedLat || item.observationLat,
        trackedLng: item.trackedLng || item.observationLng,
        observationDate: item.observed_on || "",
        distanceMeters: item.distanceMeters,
      } );
    }
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
