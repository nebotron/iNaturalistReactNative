import {
  ActivityIndicator,
  Body2,
  Body3,
  Button,
  Heading2,
  INatIcon,
  ViewWrapper,
} from "components/SharedComponents";
import BackButton from "components/SharedComponents/Buttons/BackButton";
import { ScrollView, TextInput, View } from "components/styledComponents";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, StyleSheet } from "react-native";
import type { LatLng } from "react-native-maps";
import MapView, {
  Circle,
  Marker,
  Polyline,
} from "react-native-maps";
import Geocoder from "react-native-geocoder-reborn";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

import HotspotListItem from "./HotspotListItem";
import type { Hotspot, RoutePoint } from "./hooks/useRouteHotspots";
import { useRouteHotspots } from "./hooks/useRouteHotspots";

const MAX_CIRCLE_RADIUS_M = 60_000;
const MIN_CIRCLE_RADIUS_M = 8_000;

function hotspotCircleRadius( count: number, maxCount: number ): number {
  if ( maxCount === 0 ) return MIN_CIRCLE_RADIUS_M;
  const ratio = Math.sqrt( count / maxCount );
  return MIN_CIRCLE_RADIUS_M + ratio * ( MAX_CIRCLE_RADIUS_M - MIN_CIRCLE_RADIUS_M );
}

async function geocodeText( text: string ): Promise<LatLng | null> {
  try {
    const results = await Geocoder.geocodeAddress( text );
    if ( results && results.length > 0 ) {
      return {
        latitude: results[0].position.lat,
        longitude: results[0].position.lng,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function toMapCoord( pt: RoutePoint ): LatLng {
  return { latitude: pt.latitude, longitude: pt.longitude };
}

const WildlifeHotspotsScreen = () => {
  const { t } = useTranslation();
  const mapRef = useRef<MapView>( null );

  const [startText, setStartText] = useState( "" );
  const [endText, setEndText] = useState( "" );
  const [startPoint, setStartPoint] = useState<LatLng | null>( null );
  const [endPoint, setEndPoint] = useState<LatLng | null>( null );
  const [geocodingStart, setGeocodingStart] = useState( false );
  const [geocodingEnd, setGeocodingEnd] = useState( false );
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>( null );

  const {
    hotspots, routeCoords, loading, error, findHotspots,
  } = useRouteHotspots();

  // Fit map whenever the route or hotspots change
  useEffect( () => {
    if ( routeCoords.length === 0 || !mapRef.current ) return;
    const coords: LatLng[] = routeCoords.map( toMapCoord );
    hotspots.forEach( h => coords.push( {
      latitude: h.centerLatitude,
      longitude: h.centerLongitude,
    } ) );
    mapRef.current.fitToCoordinates( coords, {
      edgePadding: { top: 60, right: 40, bottom: 60, left: 40 },
      animated: true,
    } );
  }, [routeCoords, hotspots] );

  const handleSubmitStart = useCallback( async () => {
    if ( !startText.trim() ) return;
    setGeocodingStart( true );
    const coords = await geocodeText( startText.trim() );
    setGeocodingStart( false );
    if ( coords ) {
      setStartPoint( coords );
    } else {
      Alert.alert( t( "Location-not-found" ), t( "Could-not-find-location" ) );
    }
  }, [startText, t] );

  const handleSubmitEnd = useCallback( async () => {
    if ( !endText.trim() ) return;
    setGeocodingEnd( true );
    const coords = await geocodeText( endText.trim() );
    setGeocodingEnd( false );
    if ( coords ) {
      setEndPoint( coords );
    } else {
      Alert.alert( t( "Location-not-found" ), t( "Could-not-find-location" ) );
    }
  }, [endText, t] );

  const handleFindHotspots = useCallback( async () => {
    if ( !startPoint || !endPoint ) return;
    setSelectedHotspotId( null );
    await findHotspots(
      { latitude: startPoint.latitude, longitude: startPoint.longitude },
      { latitude: endPoint.latitude, longitude: endPoint.longitude },
      {},
    );
  }, [startPoint, endPoint, findHotspots] );

  const handleHotspotPress = useCallback( ( hotspot: Hotspot ) => {
    setSelectedHotspotId( prev => ( prev === hotspot.id ? null : hotspot.id ) );
    if ( mapRef.current ) {
      mapRef.current.animateToRegion( {
        latitude: hotspot.centerLatitude,
        longitude: hotspot.centerLongitude,
        latitudeDelta: 0.5,
        longitudeDelta: 0.5,
      }, 400 );
    }
  }, [] );

  const maxCount = hotspots.reduce( ( max, h ) => Math.max( max, h.observationCount ), 0 );
  const canSearch = !!( startPoint && endPoint );

  return (
    <ViewWrapper testID="WildlifeHotspotsScreen">
      {/* Header */}
      <View className="bg-white px-3 pt-2 pb-3 flex-row items-center border-b border-lightGray">
        <BackButton />
        <View className="flex-1 ml-2">
          <Heading2 numberOfLines={1}>{t( "Wildlife-Hotspots" )}</Heading2>
        </View>
      </View>

      {/* Start/End inputs */}
      <View className="bg-white px-3 py-2 border-b border-lightGray">
        <View className="flex-row items-center mb-2">
          <View className="w-5 h-5 rounded-full bg-warningYellow mr-3 items-center justify-center">
            <INatIcon name="location" size={10} color="white" />
          </View>
          <View className="flex-1 flex-row items-center border border-lightGray rounded-lg px-3 py-1">
            <TextInput
              className="flex-1 text-darkGray"
              placeholder={t( "Start-location" )}
              value={startText}
              onChangeText={setStartText}
              onSubmitEditing={handleSubmitStart}
              returnKeyType="search"
              autoCorrect={false}
            />
            {geocodingStart
              ? <ActivityIndicator size={16} />
              : startPoint
                ? <INatIcon name="checkmark" size={16} color={colors.inatGreen} />
                : null}
          </View>
        </View>
        <View className="flex-row items-center">
          <View className="w-5 h-5 rounded-full bg-inatGreen mr-3 items-center justify-center">
            <INatIcon name="location" size={10} color="white" />
          </View>
          <View className="flex-1 flex-row items-center border border-lightGray rounded-lg px-3 py-1">
            <TextInput
              className="flex-1 text-darkGray"
              placeholder={t( "End-location" )}
              value={endText}
              onChangeText={setEndText}
              onSubmitEditing={handleSubmitEnd}
              returnKeyType="search"
              autoCorrect={false}
            />
            {geocodingEnd
              ? <ActivityIndicator size={16} />
              : endPoint
                ? <INatIcon name="checkmark" size={16} color={colors.inatGreen} />
                : null}
          </View>
        </View>
        <Button
          className="mt-3"
          text={t( "Find-Hotspots" )}
          level={canSearch ? "focus" : "neutral"}
          disabled={!canSearch || loading}
          onPress={handleFindHotspots}
          testID="WildlifeHotspots.findButton"
        />
      </View>

      {/* Map */}
      <View className="flex-1">
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFillObject}
          initialRegion={{
            latitude: 25,
            longitude: -40,
            latitudeDelta: 80,
            longitudeDelta: 100,
          }}
          rotateEnabled={false}
          pitchEnabled={false}
          showsUserLocation
        >
          {startPoint && (
            <Marker
              coordinate={startPoint}
              pinColor={colors.warningYellow}
              title={startText || t( "Start" )}
            />
          )}
          {endPoint && (
            <Marker
              coordinate={endPoint}
              pinColor={colors.inatGreen}
              title={endText || t( "End" )}
            />
          )}
          {routeCoords.length > 1 && (
            <Polyline
              coordinates={routeCoords.map( toMapCoord )}
              strokeColor={colors.darkGray}
              strokeWidth={3}
            />
          )}
          {hotspots.map( hotspot => (
            <Circle
              key={hotspot.id}
              center={{
                latitude: hotspot.centerLatitude,
                longitude: hotspot.centerLongitude,
              }}
              radius={hotspotCircleRadius( hotspot.observationCount, maxCount )}
              fillColor={
                selectedHotspotId === hotspot.id
                  ? "rgba(116,172,0,0.35)"
                  : "rgba(116,172,0,0.18)"
              }
              strokeColor={
                selectedHotspotId === hotspot.id
                  ? colors.inatGreen
                  : "rgba(116,172,0,0.5)"
              }
              strokeWidth={selectedHotspotId === hotspot.id ? 2 : 1}
            />
          ) )}
        </MapView>

        {loading && (
          <View
            className="absolute top-0 left-0 right-0 bottom-0 items-center justify-center bg-white/60"
          >
            <ActivityIndicator size={48} />
            <Body2 className="mt-3 text-darkGray">{t( "Searching-for-hotspots" )}</Body2>
          </View>
        )}
      </View>

      {/* Hotspot list */}
      {( hotspots.length > 0 || error ) && (
        <View className="max-h-56 bg-lightGray border-t border-lightGray">
          {error
            ? (
              <View className="p-4 items-center">
                <Body2 className="text-darkGray text-center">{error}</Body2>
              </View>
            )
            : (
              <ScrollView
                contentContainerStyle={{ paddingTop: 12, paddingBottom: 8 }}
                showsVerticalScrollIndicator
              >
                {hotspots.map( ( hotspot, idx ) => (
                  <HotspotListItem
                    key={hotspot.id}
                    hotspot={hotspot}
                    rank={idx + 1}
                    selected={selectedHotspotId === hotspot.id}
                    onPress={() => handleHotspotPress( hotspot )}
                  />
                ) )}
              </ScrollView>
            )}
        </View>
      )}
    </ViewWrapper>
  );
};

export default WildlifeHotspotsScreen;
