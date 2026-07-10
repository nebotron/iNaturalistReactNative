import { useNavigation } from "@react-navigation/native";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import Map from "components/SharedComponents/Map/Map";
import { Marker } from "react-native-maps";
import React, { useMemo } from "react";
import colors from "styles/tailwindColors";
import type { TabStackScreenProps } from "navigation/types";

interface LocationHistoryDetailMapParams {
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
  const navigation = useNavigation();

  const {
    observationLat,
    observationLng,
    trackedLat,
    trackedLng,
    observationDate,
    distanceMeters,
  } = params as LocationHistoryDetailMapParams;

  const initialRegion = useMemo(() => {
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
  }, [observationLat, observationLng, trackedLat, trackedLng]);

  return (
    <ScreenShell>
      <Map
        initialRegion={initialRegion}
        showCurrentLocationButton
        showSwitchMapTypeButton
        showsUserLocation
        zoomEnabled
        scrollEnabled
      >
        <Marker
          coordinate={{ latitude: observationLat, longitude: observationLng }}
          title="Photo Location"
          description={observationDate}
          pinColor={colors.inatGreen}
        />
        <Marker
          coordinate={{ latitude: trackedLat, longitude: trackedLng }}
          title="Tracked Location"
          description={
            distanceMeters === null
              ? "No nearby tracked location"
              : `${Math.round(distanceMeters)} meters away`
          }
          pinColor={colors.inatBlue}
        />
      </Map>
    </ScreenShell>
  );
};

export default LocationHistoryDetailMap;
