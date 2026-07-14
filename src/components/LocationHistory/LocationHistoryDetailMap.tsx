import { useNavigation } from "@react-navigation/native";
import { Button, List2 } from "components/SharedComponents";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import Map from "components/SharedComponents/Map/Map";
import { View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useCallback, useMemo, useState } from "react";
import { Alert } from "react-native";
import { Marker } from "react-native-maps";
import type { RealmObservation } from "realmModels/types";
import applyTrackedLocationToObservation from "sharedHelpers/applyTrackedLocationToPhotos";
import { getShadow } from "styles/global";
import colors from "styles/tailwindColors";
import type { TabStackScreenProps } from "navigation/types";

const { useObject, useRealm } = RealmContext;

interface LocationHistoryDetailMapParams {
  uuid: string;
  observationLat: number;
  observationLng: number;
  trackedLat: number;
  trackedLng: number;
  observationDate: string;
  distanceMeters: number | null;
}

const LocationHistoryDetailMap = (
  props: TabStackScreenProps<"LocationHistoryDetailMap">,
) => {
  const { params } = props.route;
  const navigation = useNavigation( );
  const realm = useRealm( );

  const {
    uuid,
    observationLat,
    observationLng,
    trackedLat,
    trackedLng,
    observationDate,
    distanceMeters,
  } = params as LocationHistoryDetailMapParams;

  const observation = useObject<RealmObservation>( "Observation", uuid );

  // The marker the user can drag to correct the observation location. Starts at
  // the current observation location and is null until the pin has been moved.
  const [editedLocation, setEditedLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>( null );
  const [isSaving, setIsSaving] = useState( false );

  const photoLocation = editedLocation ?? {
    latitude: observationLat,
    longitude: observationLng,
  };

  const hasTrackedLocation = trackedLat !== observationLat || trackedLng !== observationLng;

  const initialRegion = useMemo(() => {
    if (!hasTrackedLocation) {
      return {
        latitude: observationLat,
        longitude: observationLng,
        latitudeDelta: 0.1,
        longitudeDelta: 0.1,
      };
    }

    const minLat = Math.min(observationLat, trackedLat);
    const maxLat = Math.max(observationLat, trackedLat);
    const minLng = Math.min(observationLng, trackedLng);
    const maxLng = Math.max(observationLng, trackedLng);

    const latDelta = (maxLat - minLat) * 1.2;
    const lngDelta = (maxLng - minLng) * 1.2;

    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: Math.max(latDelta, 0.1),
      longitudeDelta: Math.max(lngDelta, 0.1),
    };
  }, [observationLat, observationLng, trackedLat, trackedLng, hasTrackedLocation]);

  const handleSave = useCallback( async ( ) => {
    if ( !editedLocation || !observation ) return;
    setIsSaving( true );
    await applyTrackedLocationToObservation( realm, observation, {
      latitude: editedLocation.latitude,
      longitude: editedLocation.longitude,
    } );
    setIsSaving( false );
    Alert.alert(
      "Location Updated",
      "The observation location has been updated.",
      [{ text: "OK", onPress: ( ) => navigation.goBack( ) }],
    );
  }, [editedLocation, observation, realm, navigation] );

  return (
    <ScreenShell>
      <Map
        initialRegion={initialRegion}
        showCurrentLocationButton
        showSwitchMapTypeButton
        zoomEnabled
        scrollEnabled
        mapChildren={(
          <>
            <Marker
              coordinate={photoLocation}
              title="Photo Location"
              description={observationDate}
              pinColor={colors.inatGreen}
              draggable
              onDragEnd={e => setEditedLocation( e.nativeEvent.coordinate )}
            />
            {hasTrackedLocation && (
              <Marker
                coordinate={{ latitude: trackedLat, longitude: trackedLng }}
                title="Tracked Location"
                description={
                  distanceMeters === null
                    ? "No nearby tracked location"
                    : `${Math.round(distanceMeters)} meters away`
                }
                pinColor={colors.blue}
              />
            )}
          </>
        )}
      >
        <View
          className="absolute bottom-5 left-5 bg-white rounded-lg py-2 px-3"
          style={getShadow()}
        >
          <View className="flex-row items-center">
            <View className="w-3 h-3 rounded-full mr-2 bg-inatGreen" />
            <List2>Photo location</List2>
          </View>
          {hasTrackedLocation && (
            <View className="flex-row items-center mt-1">
              <View className="w-3 h-3 rounded-full mr-2 bg-blue" />
              <List2>Tracked location</List2>
            </View>
          )}
          <List2 className="mt-1 text-darkGray">Drag the pin to update</List2>
        </View>
        {editedLocation && (
          <View className="absolute bottom-5 right-5 left-5 items-end">
            <Button
              text="Save location"
              onPress={handleSave}
              loading={isSaving}
              disabled={isSaving}
              level="focus"
              testID="LocationHistoryDetailMap.SaveButton"
            />
          </View>
        )}
      </Map>
    </ScreenShell>
  );
};

export default LocationHistoryDetailMap;
