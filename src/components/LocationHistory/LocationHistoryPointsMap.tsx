import { Body2, INatIconButton, List2 } from "components/SharedComponents";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import Map from "components/SharedComponents/Map/Map";
import { View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useMemo, useState } from "react";
import type { Region } from "react-native-maps";
import { Circle, Marker } from "react-native-maps";
import LocationHistoryPoint from "realmModels/LocationHistoryPoint";
import { formatLongDate } from "sharedHelpers/dateAndTime";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

const { useQuery } = RealmContext;

const pad = ( n: number ) => String( n ).padStart( 2, "0" );

// Local calendar-day key, e.g. "2026-07-15", used to bucket points by the day
// they were recorded in the device's timezone.
const dayKeyForDate = ( date: Date ) => `${date.getFullYear()}-${
  pad( date.getMonth() + 1 )}-${pad( date.getDate() )}`;

// 24-hour "HH:mm" label in the device's local time.
const timeLabelForDate = ( date: Date ) => `${pad( date.getHours() )}:${pad( date.getMinutes() )}`;

interface Day {
  key: string;
  points: LocationHistoryPoint[];
}

const regionForPoints = ( points: LocationHistoryPoint[] ): Region | undefined => {
  if ( points.length === 0 ) return undefined;
  const lats = points.map( p => p.latitude );
  const lngs = points.map( p => p.longitude );
  const minLat = Math.min( ...lats );
  const maxLat = Math.max( ...lats );
  const minLng = Math.min( ...lngs );
  const maxLng = Math.max( ...lngs );
  return {
    latitude: ( minLat + maxLat ) / 2,
    longitude: ( minLng + maxLng ) / 2,
    latitudeDelta: Math.max( ( maxLat - minLat ) * 1.4, 0.005 ),
    longitudeDelta: Math.max( ( maxLng - minLng ) * 1.4, 0.005 ),
  };
};

const LocationHistoryPointsMap = ( ) => {
  const { t, i18n } = useTranslation();

  const historyPoints = useQuery(
    {
      type: LocationHistoryPoint,
      query: points => points.sorted( "recordedAt" ),
    },
    [],
  );

  // Bucket the (ascending) points into days, preserving chronological order.
  // NB: the imported Map component shadows the JS Map constructor here, so we
  // group with a plain object + ordered array instead.
  const days = useMemo<Day[]>( ( ) => {
    const ordered: Day[] = [];
    const byKey: Record<string, Day> = {};
    historyPoints.forEach( point => {
      const key = dayKeyForDate( point.recordedAt );
      if ( byKey[key] ) {
        byKey[key].points.push( point );
      } else {
        const day = { key, points: [point] };
        byKey[key] = day;
        ordered.push( day );
      }
    } );
    return ordered;
  }, [historyPoints] );

  // null means "no explicit selection yet", which defaults to the most recent
  // day. Navigating sets an explicit index.
  const [selectedIndex, setSelectedIndex] = useState<number | null>( null );
  const effectiveIndex = selectedIndex ?? days.length - 1;
  const currentDay = days[effectiveIndex];

  const region = useMemo(
    ( ) => ( currentDay
      ? regionForPoints( currentDay.points )
      : undefined ),
    [currentDay],
  );

  if ( days.length === 0 || !currentDay ) {
    return (
      <ScreenShell>
        <View className="p-4">
          <Body2>{t( "No-location-points-recorded-yet" )}</Body2>
        </View>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell>
      <View className="flex-row items-center justify-between p-3 border-b border-lightGray">
        <INatIconButton
          icon="chevron-left-circle"
          size={30}
          accessibilityLabel={t( "Previous-day" )}
          disabled={effectiveIndex <= 0}
          onPress={( ) => setSelectedIndex( Math.max( effectiveIndex - 1, 0 ) )}
        />
        <View className="items-center">
          <Body2>{formatLongDate( currentDay.key, i18n )}</Body2>
          <List2 className="text-darkGray">
            {t( "X-Location-Points-Recorded", { count: currentDay.points.length } )}
          </List2>
        </View>
        <INatIconButton
          icon="chevron-right-circle"
          size={30}
          accessibilityLabel={t( "Next-day" )}
          disabled={effectiveIndex >= days.length - 1}
          onPress={( ) => setSelectedIndex( Math.min( effectiveIndex + 1, days.length - 1 ) )}
        />
      </View>
      <Map
        initialRegion={region}
        regionToAnimate={region}
        showCurrentLocationButton
        showSwitchMapTypeButton
        zoomEnabled
        scrollEnabled
        mapChildren={(
          <>
            {currentDay.points.map( point => {
              const coordinate = {
                latitude: point.latitude,
                longitude: point.longitude,
              };
              return (
                <React.Fragment key={point.uuid}>
                  {point.accuracy != null && point.accuracy > 0 && (
                    <Circle
                      center={coordinate}
                      radius={point.accuracy}
                      strokeColor={colors.inatGreen}
                      strokeWidth={1}
                      fillColor={`${colors.inatGreen}22`}
                    />
                  )}
                  <Marker coordinate={coordinate} anchor={{ x: 0.5, y: 0.5 }}>
                    <View className="items-center">
                      <View className="bg-white rounded px-1 border border-inatGreen">
                        <List2>{timeLabelForDate( point.recordedAt )}</List2>
                      </View>
                      <View className="w-2 h-2 rounded-full bg-inatGreen mt-0.5" />
                    </View>
                  </Marker>
                </React.Fragment>
              );
            } )}
          </>
        )}
      />
    </ScreenShell>
  );
};

export default LocationHistoryPointsMap;
