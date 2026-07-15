import { useNavigation } from "@react-navigation/native";
import { Button, INatIcon, List2 } from "components/SharedComponents";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import Map from "components/SharedComponents/Map/Map";
import { View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import type { Region } from "react-native-maps";
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

  // The corrected observation location. The user moves it by dragging the map
  // under the fixed center pin (see LocationPicker for the same pattern). It's
  // null until the map has been moved, so the Save button only appears then.
  const [editedLocation, setEditedLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>( null );
  const [isSaving, setIsSaving] = useState( false );

  // onRegionChangeComplete fires once on the initial render; we ignore that so
  // the Save button doesn't appear until the user actually drags the map.
  const isFirstRegionChange = useRef( true );

  const hasTrackedLocation = trackedLat !== observationLat || trackedLng !== observationLng;

  // Center the map on the photo location (so the fixed center pin starts on it)
  // and widen the zoom enough to keep the tracked-location marker in view.
  const initialRegion = useMemo(() => {
    const latSpan = hasTrackedLocation
      ? Math.abs( observationLat - trackedLat ) * 2 * 1.2
      : 0;
    const lngSpan = hasTrackedLocation
      ? Math.abs( observationLng - trackedLng ) * 2 * 1.2
      : 0;

    return {
      latitude: observationLat,
      longitude: observationLng,
      latitudeDelta: Math.max( latSpan, 0.02 ),
      longitudeDelta: Math.max( lngSpan, 0.02 ),
    };
  }, [observationLat, observationLng, trackedLat, trackedLng, hasTrackedLocation]);

  const handleRegionChangeComplete = useCallback( ( newRegion: Region ) => {
    if ( isFirstRegionChange.current ) {
      isFirstRegionChange.current = false;
      return;
    }
    setEditedLocation( {
      latitude: newRegion.latitude,
      longitude: newRegion.longitude,
    } );
  }, [] );

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
        onRegionChangeComplete={handleRegionChangeComplete}
        showCurrentLocationButton
        showSwitchMapTypeButton
        zoomEnabled
        scrollEnabled
        mapChildren={(
          hasTrackedLocation && (
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
          )
        )}
      >
        {/* Fixed center pin: the map moves under it, so its tip always marks
            the photo location. pointerEvents none so drags reach the map. */}
        <View
          className="absolute inset-0 items-center justify-center"
          pointerEvents="none"
        >
          <INatIcon
            name="map-marker-outline"
            size={40}
            color={colors.inatGreen}
            // Offset up by half the icon height so the pin's tip, not its
            // center, sits on the map center.
            style={{ marginBottom: 40 }}
          />
        </View>
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
          <List2 className="mt-1 text-darkGray">Drag the map to update</List2>
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
