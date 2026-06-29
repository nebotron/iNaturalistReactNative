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
import type { TabStackScreenProps } from "navigation/types";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Alert,
  Linking,
  StyleSheet,
  TouchableOpacity,
} from "react-native";
import type { LatLng } from "react-native-maps";
import MapView, {
  Marker,
  Polyline,
} from "react-native-maps";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

import HotspotListItem from "./HotspotListItem";
import type { Hotspot, RoutePoint } from "./hooks/useRouteHotspots";
import { fetchOSRMRoute, useRouteHotspots } from "./hooks/useRouteHotspots";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
}

async function searchNominatim( text: string ): Promise<NominatimResult[]> {
  try {
    const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent( text )}&format=json&limit=5`;
    const response = await fetch( url, {
      headers: { "Accept-Language": "en" },
    } );
    if ( !response.ok ) return [];
    return response.json();
  } catch {
    return [];
  }
}

function toMapCoord( pt: RoutePoint ): LatLng {
  return { latitude: pt.latitude, longitude: pt.longitude };
}

interface AddressInputProps {
  placeholder: string;
  value: string;
  onChangeText: ( text: string ) => void;
  onSelectSuggestion: ( result: NominatimResult ) => void;
  confirmed: boolean;
  loading: boolean;
  dotColor: string;
}

const AddressInput = ( {
  placeholder,
  value,
  onChangeText,
  onSelectSuggestion,
  confirmed,
  loading,
  dotColor,
}: AddressInputProps ) => {
  const [suggestions, setSuggestions] = useState<NominatimResult[]>( [] );
  const [searching, setSearching] = useState( false );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>( null );

  const handleChange = useCallback( ( text: string ) => {
    onChangeText( text );
    if ( debounceRef.current ) clearTimeout( debounceRef.current );
    if ( text.trim().length < 3 ) {
      setSuggestions( [] );
      return;
    }
    debounceRef.current = setTimeout( async () => {
      setSearching( true );
      const results = await searchNominatim( text.trim() );
      setSuggestions( results );
      setSearching( false );
    }, 350 );
  }, [onChangeText] );

  const handleSelect = useCallback( ( result: NominatimResult ) => {
    setSuggestions( [] );
    onSelectSuggestion( result );
  }, [onSelectSuggestion] );

  return (
    <View className="flex-1">
      <View className="flex-row items-center border border-lightGray rounded-lg px-3 py-1">
        <View
          className="w-4 h-4 rounded-full mr-2 items-center justify-center"
          style={{ backgroundColor: dotColor }}
        >
          <INatIcon name="location" size={8} color="white" />
        </View>
        <TextInput
          className="flex-1 text-darkGray"
          placeholder={placeholder}
          value={value}
          onChangeText={handleChange}
          autoCorrect={false}
          autoCapitalize="none"
        />
        {( loading || searching ) && <ActivityIndicator size={16} />}
        {confirmed && !loading && !searching && (
          <INatIcon name="checkmark" size={16} color={colors.inatGreen} />
        )}
      </View>
      {suggestions.length > 0 && (
        <View
          className="absolute top-10 left-0 right-0 bg-white border border-lightGray rounded-lg z-50"
          style={{ elevation: 8, shadowOpacity: 0.15, shadowRadius: 4 }}
        >
          {suggestions.map( result => (
            <TouchableOpacity
              key={result.place_id}
              className="px-3 py-2 border-b border-lightGray"
              onPress={() => handleSelect( result )}
            >
              <Body3 numberOfLines={2}>{result.display_name}</Body3>
            </TouchableOpacity>
          ) )}
        </View>
      )}
    </View>
  );
};

type Props = TabStackScreenProps<"WildlifeHotspots">;

const WildlifeHotspotsScreen = ( { route }: Props ) => {
  const { t } = useTranslation();
  const mapRef = useRef<MapView>( null );
  const filterParams = route?.params?.filterParams ?? {};

  const [startText, setStartText] = useState( "" );
  const [endText, setEndText] = useState( "" );
  const [startPoint, setStartPoint] = useState<LatLng | null>( null );
  const [endPoint, setEndPoint] = useState<LatLng | null>( null );
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>( null );
  const [hotspotRouteCoords, setHotspotRouteCoords] = useState<RoutePoint[]>( [] );
  const [hotspotRouteLoading, setHotspotRouteLoading] = useState( false );

  const {
    hotspots, routeCoords, loading, error, findHotspots,
  } = useRouteHotspots();

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

  const handleSelectStart = useCallback( ( result: NominatimResult ) => {
    setStartText( result.display_name );
    setStartPoint( { latitude: parseFloat( result.lat ), longitude: parseFloat( result.lon ) } );
  }, [] );

  const handleSelectEnd = useCallback( ( result: NominatimResult ) => {
    setEndText( result.display_name );
    setEndPoint( { latitude: parseFloat( result.lat ), longitude: parseFloat( result.lon ) } );
  }, [] );

  const handleStartTextChange = useCallback( ( text: string ) => {
    setStartText( text );
    setStartPoint( null );
  }, [] );

  const handleEndTextChange = useCallback( ( text: string ) => {
    setEndText( text );
    setEndPoint( null );
  }, [] );

  const handleFindHotspots = useCallback( async () => {
    if ( !startPoint || !endPoint ) {
      Alert.alert( t( "Location-not-found" ), t( "Please-select-a-location-from-the-suggestions" ) );
      return;
    }
    setSelectedHotspotId( null );
    setHotspotRouteCoords( [] );
    await findHotspots(
      { latitude: startPoint.latitude, longitude: startPoint.longitude },
      { latitude: endPoint.latitude, longitude: endPoint.longitude },
      filterParams,
    );
  }, [startPoint, endPoint, findHotspots, t] );

  const handleHotspotPress = useCallback( async ( hotspot: Hotspot ) => {
    const isDeselecting = selectedHotspotId === hotspot.id;
    setSelectedHotspotId( isDeselecting ? null : hotspot.id );
    if ( isDeselecting ) {
      setHotspotRouteCoords( [] );
      return;
    }
    if ( mapRef.current ) {
      mapRef.current.animateToRegion( {
        latitude: hotspot.centerLatitude,
        longitude: hotspot.centerLongitude,
        latitudeDelta: 0.5,
        longitudeDelta: 0.5,
      }, 400 );
    }
    if ( !startPoint || !endPoint ) return;
    setHotspotRouteLoading( true );
    try {
      const via = { latitude: hotspot.centerLatitude, longitude: hotspot.centerLongitude };
      const [leg1, leg2] = await Promise.all( [
        fetchOSRMRoute( startPoint, via ),
        fetchOSRMRoute( via, endPoint ),
      ] );
      setHotspotRouteCoords( [...leg1.coords, ...leg2.coords] );
      if ( mapRef.current ) {
        const allCoords: LatLng[] = [...leg1.coords, ...leg2.coords].map(
          p => ( { latitude: p.latitude, longitude: p.longitude } ),
        );
        mapRef.current.fitToCoordinates( allCoords, {
          edgePadding: { top: 60, right: 40, bottom: 60, left: 40 },
          animated: true,
        } );
      }
    } catch {
      // silently ignore route fetch failure for hotspot
    } finally {
      setHotspotRouteLoading( false );
    }
  }, [selectedHotspotId, startPoint, endPoint] );

  const handleOpenInGoogleMaps = useCallback( ( hotspot: Hotspot ) => {
    if ( !startPoint || !endPoint ) return;
    const origin = `${startPoint.latitude},${startPoint.longitude}`;
    const destination = `${endPoint.latitude},${endPoint.longitude}`;
    const waypoint = `${hotspot.centerLatitude},${hotspot.centerLongitude}`;
    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&waypoints=${waypoint}&travelmode=driving`;
    Linking.openURL( url );
  }, [startPoint, endPoint] );

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
      <View className="bg-white px-3 py-2 border-b border-lightGray" style={{ zIndex: 10 }}>
        <View className="flex-row items-center mb-2" style={{ zIndex: 20 }}>
          <AddressInput
            placeholder={t( "Start-location" )}
            value={startText}
            onChangeText={handleStartTextChange}
            onSelectSuggestion={handleSelectStart}
            confirmed={!!startPoint}
            loading={false}
            dotColor={colors.warningYellow}
          />
        </View>
        <View className="flex-row items-center" style={{ zIndex: 10 }}>
          <AddressInput
            placeholder={t( "End-location" )}
            value={endText}
            onChangeText={handleEndTextChange}
            onSelectSuggestion={handleSelectEnd}
            confirmed={!!endPoint}
            loading={false}
            dotColor={colors.inatGreen}
          />
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
              strokeColor={colors.blue}
              strokeWidth={3}
            />
          )}
          {hotspotRouteCoords.length > 1 && (
            <Polyline
              coordinates={hotspotRouteCoords.map( toMapCoord )}
              strokeColor={colors.inatGreen}
              strokeWidth={4}
            />
          )}
          {hotspots.map( hotspot => (
            <Marker
              key={hotspot.id}
              coordinate={{
                latitude: hotspot.centerLatitude,
                longitude: hotspot.centerLongitude,
              }}
              pinColor={
                selectedHotspotId === hotspot.id
                  ? colors.inatGreen
                  : colors.warningYellow
              }
              onPress={() => handleHotspotPress( hotspot )}
            />
          ) )}
        </MapView>

        {( loading || hotspotRouteLoading ) && (
          <View
            className="absolute top-0 left-0 right-0 bottom-0 items-center justify-center bg-white/60"
          >
            <ActivityIndicator size={48} />
            <Body2 className="mt-3 text-darkGray">
              {loading ? t( "Searching-for-hotspots" ) : t( "Loading-route" )}
            </Body2>
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
                    onOpenInGoogleMaps={() => handleOpenInGoogleMaps( hotspot )}
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
