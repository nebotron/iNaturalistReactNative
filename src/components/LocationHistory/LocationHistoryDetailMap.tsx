import { useNavigation } from "@react-navigation/native";
import LocationPickerContainer from "components/LocationPicker/LocationPickerContainer";
import { List2 } from "components/SharedComponents";
import { View } from "components/styledComponents";
import type { TabStackScreenProps } from "navigation/types";
import { RealmContext } from "providers/contexts";
import React, { useCallback, useMemo } from "react";
import { Marker } from "react-native-maps";
import type { RealmObservation } from "realmModels/types";
import applyTrackedLocationToObservation from "sharedHelpers/applyTrackedLocationToPhotos";
import { UPLOAD_PENDING } from "stores/createUploadObservationsSlice";
import useStore from "stores/useStore";
import { getShadow } from "styles/global";
import colors from "styles/tailwindColors";

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

  const addTotalToolbarIncrements = useStore( state => state.addTotalToolbarIncrements );
  const addToUploadQueue = useStore( state => state.addToUploadQueue );
  const setStartUploadObservations = useStore( state => state.setStartUploadObservations );
  const uploadStatus = useStore( state => state.uploadStatus );

  const hasTrackedLocation = trackedLat !== observationLat || trackedLng !== observationLng;

  // Reference markers shown under the crosshair: the photo's current location
  // (green) and, if available, the interpolated tracked location (blue). The
  // user drags the map to move the crosshair onto the desired spot.
  const mapChildren = useMemo( ( ) => (
    <>
      <Marker
        coordinate={{ latitude: observationLat, longitude: observationLng }}
        title="Photo location"
        description={observationDate}
        pinColor={colors.inatGreen}
      />
      {hasTrackedLocation && (
        <Marker
          coordinate={{ latitude: trackedLat, longitude: trackedLng }}
          title="Tracked location"
          description={
            distanceMeters === null
              ? "No nearby tracked location"
              : `${Math.round( distanceMeters )} meters away`
          }
          pinColor={colors.blue}
        />
      )}
    </>
  ), [
    observationLat,
    observationLng,
    trackedLat,
    trackedLng,
    observationDate,
    distanceMeters,
    hasTrackedLocation,
  ] );

  const legend = useMemo( ( ) => (
    <View
      className="absolute bottom-5 left-5 bg-white rounded-lg py-2 px-3"
      style={getShadow()}
      pointerEvents="none"
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
    </View>
  ), [hasTrackedLocation] );

  const handleSave = useCallback( async location => {
    if ( observation ) {
      await applyTrackedLocationToObservation( realm, observation, {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.positional_accuracy,
        placeGuess: location.place_guess,
      } );
      // No confirmation modal: immediately queue the updated observation for
      // upload.
      addTotalToolbarIncrements( observation );
      addToUploadQueue( observation.uuid );
      if ( uploadStatus === UPLOAD_PENDING ) {
        setStartUploadObservations( );
      }
    }
    navigation.goBack( );
  }, [
    observation,
    realm,
    navigation,
    addTotalToolbarIncrements,
    addToUploadQueue,
    setStartUploadObservations,
    uploadStatus,
  ] );

  return (
    <LocationPickerContainer
      observation={observation}
      onSave={handleSave}
      mapChildren={mapChildren}
      legend={legend}
    />
  );
};

export default LocationHistoryDetailMap;
