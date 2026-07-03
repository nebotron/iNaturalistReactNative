import { useNavigation } from "@react-navigation/native";
import {
  ActivityIndicator,
  Body2,
  Body3,
  INatIcon,
  ViewWrapper,
} from "components/SharedComponents";
import { ScrollView, TextInput, View } from "components/styledComponents";
import fetchAccurateUserLocation from "sharedHelpers/fetchAccurateUserLocation";
import type { TabStackScreenProps } from "navigation/types";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Keyboard,
  Linking,
  StyleSheet,
  TouchableOpacity,
} from "react-native";
import type { RenderItemParams } from "react-native-draggable-flatlist";
import DraggableFlatList, { ScaleDecorator } from "react-native-draggable-flatlist";
import type { LatLng } from "react-native-maps";
import MapView, {
  Marker,
  Polyline,
} from "react-native-maps";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

import HotspotListItem from "./HotspotListItem";
import type { Hotspot, RoutePoint } from "./hooks/useRouteHotspots";
import { fetchOSRMRoute, findBestInsertion, useRouteHotspots } from "./hooks/useRouteHotspots";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
}

async function searchNominatim(
  text: string,
  nearbyLatLng?: LatLng,
): Promise<NominatimResult[]> {
  try {
    let url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent( text )}&format=json&limit=3`;
    if ( nearbyLatLng ) {
      const { latitude: lat, longitude: lon } = nearbyLatLng;
      const delta = 2;
      url += `&viewbox=${lon - delta},${lat + delta},${lon + delta},${lat - delta}`;
    }
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

interface Stop {
  id: string;
  text: string;
  point: LatLng | null;
}

let stopIdCounter = 0;
function makeStopId(): string {
  stopIdCounter += 1;
  return `stop-${Date.now()}-${stopIdCounter}`;
}

function stopDotColor( index: number, count: number ): string {
  if ( index === 0 ) return colors.warningYellow;
  if ( index === count - 1 ) return colors.inatGreen;
  return colors.blue;
}

interface AddressInputProps {
  placeholder: string;
  value: string;
  onChangeText: ( text: string ) => void;
  onSelectSuggestion: ( result: NominatimResult ) => void;
  confirmed: boolean;
  loading: boolean;
  dotColor: string;
  nearbyLatLng?: LatLng;
}

const AddressInput = ( {
  placeholder,
  value,
  onChangeText,
  onSelectSuggestion,
  confirmed,
  loading,
  dotColor,
  nearbyLatLng,
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
      const results = await searchNominatim( text.trim(), nearbyLatLng );
      setSuggestions( results );
      setSearching( false );
    }, 200 );
  }, [onChangeText, nearbyLatLng] );

  const handleSelect = useCallback( ( result: NominatimResult ) => {
    setSuggestions( [] );
    Keyboard.dismiss();
    onSelectSuggestion( result );
  }, [onSelectSuggestion] );

  const handleClear = useCallback( () => {
    handleChange( "" );
  }, [handleChange] );

  return (
    <View className="flex-1">
      <TouchableOpacity
        activeOpacity={1}
        onPress={handleClear}
        className="flex-row items-center border border-lightGray rounded-lg px-3 py-1"
      >
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
          onFocus={handleClear}
          autoCorrect={false}
          autoCapitalize="none"
          editable={true}
        />
        {( loading || searching ) && <ActivityIndicator size={16} />}
        {confirmed && !loading && !searching && (
          <INatIcon name="checkmark" size={16} color={colors.inatGreen} />
        )}
      </TouchableOpacity>
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
  const navigation = useNavigation();
  const mapRef = useRef<MapView>( null );
  const filterParams = route?.params?.filterParams ?? {};

  const [stops, setStops] = useState<Stop[]>( [
    { id: makeStopId(), text: "", point: null },
    { id: makeStopId(), text: "", point: null },
  ] );
  const [userLocation, setUserLocation] = useState<LatLng | null>( null );
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>( null );
  const [hotspotRouteCoords, setHotspotRouteCoords] = useState<RoutePoint[]>( [] );
  const [hotspotRouteLoading, setHotspotRouteLoading] = useState( false );

  const {
    hotspots, routeCoords, loading, error, findHotspots,
  } = useRouteHotspots();

  const confirmedStopPoints = stops
    .filter( s => s.point )
    .map( s => ( { latitude: ( s.point as LatLng ).latitude, longitude: ( s.point as LatLng ).longitude } ) );

  useEffect( () => {
    const initializeLocation = async () => {
      const loc = await fetchAccurateUserLocation();
      if ( loc ) {
        const latLng = { latitude: loc.latitude, longitude: loc.longitude };
        setUserLocation( latLng );
        setStops( prev => prev.map( s => ( {
          ...s,
          point: latLng,
          text: t( "Current-location" ),
        } ) ) );
      }
    };
    initializeLocation();
  }, [t] );

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

  const handleStopTextChange = useCallback( ( id: string, text: string ) => {
    setStops( prev => prev.map( s => ( s.id === id ? { ...s, text, point: null } : s ) ) );
  }, [] );

  const handleSelectStopSuggestion = useCallback( ( id: string, result: NominatimResult ) => {
    setStops( prev => prev.map( s => ( s.id === id
      ? {
        ...s,
        text: result.display_name,
        point: { latitude: parseFloat( result.lat ), longitude: parseFloat( result.lon ) },
      }
      : s ) ) );
  }, [] );

  const handleAddStop = useCallback( () => {
    setStops( prev => [
      ...prev.slice( 0, prev.length - 1 ),
      { id: makeStopId(), text: "", point: null },
      prev[prev.length - 1],
    ] );
  }, [] );

  const handleRemoveStop = useCallback( ( id: string ) => {
    setStops( prev => ( prev.length > 2 ? prev.filter( s => s.id !== id ) : prev ) );
  }, [] );

  const handleReorderStops = useCallback( ( { data }: { data: Stop[] } ) => {
    setStops( data );
  }, [] );

  useEffect( () => {
    if ( confirmedStopPoints.length !== stops.length || stops.length < 2 ) return;
    setSelectedHotspotId( null );
    setHotspotRouteCoords( [] );
    findHotspots( confirmedStopPoints, filterParams );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, findHotspots, filterParams] );

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
    if ( confirmedStopPoints.length < 2 ) return;
    setHotspotRouteLoading( true );
    try {
      const via = { latitude: hotspot.centerLatitude, longitude: hotspot.centerLongitude };
      const insertIdx = findBestInsertion( confirmedStopPoints, via );
      const withVia = [
        ...confirmedStopPoints.slice( 0, insertIdx ),
        via,
        ...confirmedStopPoints.slice( insertIdx ),
      ];
      const { coords } = await fetchOSRMRoute( withVia );
      setHotspotRouteCoords( coords );
      if ( mapRef.current ) {
        mapRef.current.fitToCoordinates( coords.map( toMapCoord ), {
          edgePadding: { top: 60, right: 40, bottom: 60, left: 40 },
          animated: true,
        } );
      }
    } catch {
      // silently ignore route fetch failure for hotspot
    } finally {
      setHotspotRouteLoading( false );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHotspotId, stops] );

  const handleAddHotspotToRoute = useCallback( ( hotspot: Hotspot ) => {
    if ( confirmedStopPoints.length < 2 ) return;
    const via = { latitude: hotspot.centerLatitude, longitude: hotspot.centerLongitude };
    const insertIdx = findBestInsertion( confirmedStopPoints, via );
    const newStop: Stop = { id: makeStopId(), text: t( "Hotspot" ), point: via };
    setStops( prev => [...prev.slice( 0, insertIdx ), newStop, ...prev.slice( insertIdx )] );
    setSelectedHotspotId( null );
    setHotspotRouteCoords( [] );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, t] );

  const handleObservationPress = useCallback( ( uuid: string ) => {
    navigation.push( "ObsDetails", { uuid } );
  }, [navigation] );

  const renderStopItem = useCallback( ( { item: stop, getIndex, drag, isActive }: RenderItemParams<Stop> ) => {
    const index = getIndex() ?? 0;
    return (
      <ScaleDecorator>
        <View
          className={`flex-row items-center bg-white ${index < stops.length - 1 ? "mb-2" : ""}`}
          style={{ zIndex: stops.length - index, opacity: isActive ? 0.7 : 1 }}
        >
          <TouchableOpacity
            onLongPress={drag}
            disabled={isActive}
            className="mr-2 p-1"
            accessibilityRole="button"
            accessibilityLabel={t( "Reorder-stop" )}
          >
            <INatIcon name="list" size={16} color={colors.darkGray} />
          </TouchableOpacity>
          <AddressInput
            placeholder={
              index === 0
                ? t( "Start-location" )
                : index === stops.length - 1
                  ? t( "End-location" )
                  : t( "Add-stop" )
            }
            value={stop.text}
            onChangeText={text => handleStopTextChange( stop.id, text )}
            onSelectSuggestion={result => handleSelectStopSuggestion( stop.id, result )}
            confirmed={!!stop.point}
            loading={false}
            dotColor={stopDotColor( index, stops.length )}
            nearbyLatLng={stops[index - 1]?.point ?? userLocation ?? undefined}
          />
          {index > 0 && index < stops.length - 1 && (
            <TouchableOpacity
              onPress={() => handleRemoveStop( stop.id )}
              className="ml-2 p-1"
              accessibilityRole="button"
              accessibilityLabel={t( "Remove-stop" )}
            >
              <INatIcon name="close" size={16} color={colors.darkGray} />
            </TouchableOpacity>
          )}
        </View>
      </ScaleDecorator>
    );
  }, [stops, userLocation, t, handleStopTextChange, handleSelectStopSuggestion, handleRemoveStop] );

  const handleOpenInGoogleMaps = useCallback( ( hotspot: Hotspot ) => {
    if ( confirmedStopPoints.length < 2 ) return;
    const first = confirmedStopPoints[0];
    const last = confirmedStopPoints[confirmedStopPoints.length - 1];
    const origin = `${first.latitude},${first.longitude}`;
    const destination = `${last.latitude},${last.longitude}`;
    const waypointPoints = [
      ...confirmedStopPoints.slice( 1, -1 ),
      { latitude: hotspot.centerLatitude, longitude: hotspot.centerLongitude },
    ];
    const waypoints = waypointPoints.map( p => `${p.latitude},${p.longitude}` ).join( "|" );
    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&waypoints=${waypoints}&travelmode=driving`;
    Linking.openURL( url );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops] );

  return (
    <ViewWrapper testID="WildlifeHotspotsScreen">
      {/* Stop inputs */}
      <View className="bg-white px-3 py-2 border-b border-lightGray" style={{ zIndex: 10 }}>
        <DraggableFlatList
          data={stops}
          keyExtractor={stop => stop.id}
          renderItem={renderStopItem}
          onDragEnd={handleReorderStops}
          scrollEnabled={false}
        />
        <TouchableOpacity
          onPress={handleAddStop}
          className="flex-row items-center mt-1"
          accessibilityRole="button"
        >
          <INatIcon name="plus" size={14} color={colors.inatGreen} />
          <Body3 className="ml-1 text-inatGreen">{t( "Add-stop" )}</Body3>
        </TouchableOpacity>
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
          {stops.map( ( stop, index ) => stop.point && (
            <Marker
              key={stop.id}
              coordinate={stop.point}
              pinColor={stopDotColor( index, stops.length )}
              title={stop.text || `${t( "Stop-noun" )} ${index + 1}`}
            />
          ) )}
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
          {hotspots
            .find( h => h.id === selectedHotspotId )
            ?.observations.map( obs => (
              <Marker
                key={obs.uuid}
                coordinate={{ latitude: obs.latitude, longitude: obs.longitude }}
                anchor={{ x: 0.5, y: 0.5 }}
                onPress={() => handleObservationPress( obs.uuid )}
              >
                <View
                  className="w-2.5 h-2.5 rounded-full border border-white"
                  style={{ backgroundColor: colors.inatGreen }}
                />
              </Marker>
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
                    onAddToRoute={() => handleAddHotspotToRoute( hotspot )}
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
