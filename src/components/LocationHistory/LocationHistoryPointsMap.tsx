import { Body2, List2 } from "components/SharedComponents";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import Map from "components/SharedComponents/Map/Map";
import { View } from "components/styledComponents";
import type { i18n as i18next } from "i18next";
import { RealmContext } from "providers/contexts";
import React, { useMemo, useState } from "react";
import { FlatList, Pressable } from "react-native";
import { Marker, Polyline } from "react-native-maps";
import LocationHistoryPoint from "realmModels/LocationHistoryPoint";
import { formatLongDatetime } from "sharedHelpers/dateAndTime";
import { useTranslation } from "sharedHooks";
import { getShadow } from "styles/global";
import colors from "styles/tailwindColors";

const { useQuery } = RealmContext;

const PointRow = ( { index, point, i18n }: {
  index: number;
  point: LocationHistoryPoint;
  i18n: i18next;
} ) => (
  <View className="flex-row items-center p-3 border-b border-lightGray">
    <Body2 className="w-8 text-darkGray">{index + 1}</Body2>
    <View className="flex-1">
      <Body2>
        {formatLongDatetime( point.recordedAt.toISOString(), i18n )}
      </Body2>
      <List2 className="text-darkGray">
        {`${point.latitude.toFixed( 5 )}, ${point.longitude.toFixed( 5 )}`}
      </List2>
    </View>
  </View>
);

const LocationHistoryPointsMap = ( ) => {
  const { t, i18n } = useTranslation();
  const [showMap, setShowMap] = useState( false );

  const historyPoints = useQuery(
    {
      type: LocationHistoryPoint,
      query: points => points.sorted( "recordedAt" ),
    },
    [],
  );

  const coordinates = useMemo(
    ( ) => historyPoints.map( point => ( {
      latitude: point.latitude,
      longitude: point.longitude,
    } ) ),
    [historyPoints],
  );

  const initialRegion = useMemo( ( ) => {
    if ( coordinates.length === 0 ) return undefined;
    const lats = coordinates.map( c => c.latitude );
    const lngs = coordinates.map( c => c.longitude );
    const minLat = Math.min( ...lats );
    const maxLat = Math.max( ...lats );
    const minLng = Math.min( ...lngs );
    const maxLng = Math.max( ...lngs );
    return {
      latitude: ( minLat + maxLat ) / 2,
      longitude: ( minLng + maxLng ) / 2,
      latitudeDelta: Math.max( ( maxLat - minLat ) * 1.4, 0.02 ),
      longitudeDelta: Math.max( ( maxLng - minLng ) * 1.4, 0.02 ),
    };
  }, [coordinates] );

  const toggle = (
    <View className="flex-row p-3 border-b border-lightGray">
      <Pressable
        accessibilityRole="button"
        className="flex-1 items-center py-2"
        onPress={( ) => setShowMap( false )}
        testID="LocationHistoryPointsMap.ListToggle"
      >
        <Body2 className={showMap
          ? "text-darkGray"
          : "text-inatGreen"}
        >
          {t( "List" )}
        </Body2>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        className="flex-1 items-center py-2"
        onPress={( ) => setShowMap( true )}
        testID="LocationHistoryPointsMap.MapToggle"
      >
        <Body2 className={showMap
          ? "text-inatGreen"
          : "text-darkGray"}
        >
          {t( "Map" )}
        </Body2>
      </Pressable>
    </View>
  );

  if ( showMap ) {
    return (
      <ScreenShell>
        {toggle}
        {coordinates.length === 0
          ? (
            <View className="p-4">
              <Body2>{t( "No-location-points-recorded-yet" )}</Body2>
            </View>
          )
          : (
            <Map
              initialRegion={initialRegion}
              showCurrentLocationButton
              showSwitchMapTypeButton
              zoomEnabled
              scrollEnabled
              mapChildren={(
                <>
                  {coordinates.length > 1 && (
                    <Polyline
                      coordinates={coordinates}
                      strokeColor={colors.inatGreen}
                      strokeWidth={3}
                    />
                  )}
                  <Marker
                    coordinate={coordinates[0]}
                    title={t( "Start" )}
                    pinColor={colors.inatGreen}
                  />
                  {coordinates.length > 1 && (
                    <Marker
                      coordinate={coordinates[coordinates.length - 1]}
                      title={t( "End" )}
                      pinColor={colors.warningRed}
                    />
                  )}
                </>
              )}
            >
              <View
                className="absolute bottom-5 left-5 bg-white rounded-lg py-2 px-3"
                style={getShadow()}
              >
                <List2>
                  {t( "X-Location-Points-Recorded", { count: coordinates.length } )}
                </List2>
              </View>
            </Map>
          )}
      </ScreenShell>
    );
  }

  return (
    <ScreenShell>
      {toggle}
      <FlatList
        data={historyPoints}
        keyExtractor={item => item.uuid}
        renderItem={( { item, index } ) => (
          <PointRow index={index} point={item} i18n={i18n} />
        )}
        ListEmptyComponent={(
          <View className="p-4">
            <Body2>{t( "No-location-points-recorded-yet" )}</Body2>
          </View>
        )}
      />
    </ScreenShell>
  );
};

export default LocationHistoryPointsMap;
