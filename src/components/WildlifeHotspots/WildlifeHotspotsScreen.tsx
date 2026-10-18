import { useNavigation } from "@react-navigation/native";
import {
  ActivityIndicator,
  Body2,
  Body3,
  Body4,
  INatIcon,
  ViewWrapper,
} from "components/SharedComponents";
import Map from "components/SharedComponents/Map/Map";
import { TextInput, View } from "components/styledComponents";
import { useStackHost } from "navigation/StackHostContext";
import type { TabStackScreenProps } from "navigation/types";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Keyboard,
  Linking,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
} from "react-native";
import type { RenderItemParams } from "react-native-draggable-flatlist";
import DraggableFlatList, { ScaleDecorator } from "react-native-draggable-flatlist";
import type MapView from "react-native-maps";
import type { LatLng, Region } from "react-native-maps";
import { Marker, Polyline } from "react-native-maps";
import type { ICarouselInstance } from "react-native-reanimated-carousel";
import Carousel from "react-native-reanimated-carousel";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import fetchAccurateUserLocation from "sharedHelpers/fetchAccurateUserLocation";
import { getLatestTrackedLocation } from "sharedHelpers/locationHistoryTracker";
import { useTranslation } from "sharedHooks";
import useStore, { zustandStorage } from "stores/useStore";
import colors from "styles/tailwindColors";

import type { Hotspot, HotspotSpecies, RoutePoint } from "./hooks/useRouteHotspots";
import { fetchOSRMRoute, findBestInsertion, useRouteHotspots } from "./hooks/useRouteHotspots";
import HotspotListItem from "./HotspotListItem";
import type { PlaceResult } from "./placeSearch";
import { searchPlaces } from "./placeSearch";

// Synthetic place_id marking the "current location" row in the dropdown, which
// resolves to the device location rather than a searched address.
const CURRENT_LOCATION_PLACE_ID = -1;
const INITIAL_REGION: Region = {
  latitude: 25,
  longitude: -40,
  latitudeDelta: 80,
  longitudeDelta: 100,
};
// Number of recently entered addresses to offer before the user types.
const RECENT_ADDRESS_COUNT = 10;

function toMapCoord( pt: RoutePoint ): LatLng {
  return { latitude: pt.latitude, longitude: pt.longitude };
}

interface Stop {
  id: string;
  text: string;
  point: LatLng | null;
  // Set when the stop was added from a hotspot card
  fromHotspot?: boolean;
}

function isAtPoint( hotspot: Hotspot, point: LatLng ): boolean {
  return hotspot.centerLatitude === point.latitude
    && hotspot.centerLongitude === point.longitude;
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

function stopPlaceholder(
  index: number,
  count: number,
  t: ( key: string ) => string,
): string {
  if ( index === 0 ) return t( "Start-location" );
  if ( index === count - 1 ) return t( "End-location" );
  return t( "Add-stop" );
}

interface AddressInputProps {
  placeholder: string;
  value: string;
  onChangeText: ( text: string ) => void;
  onSuggestionsChange: ( suggestions: PlaceResult[] ) => void;
  confirmed: boolean;
  dotColor: string;
  nearbyLatLng?: LatLng;
  onEmptyBlur?: () => void;
  // Shown in the dropdown before the user types (recent addresses + current
  // location), so the field can be filled without searching.
  presetSuggestions: PlaceResult[];
  // Previously entered addresses, most-recent first; those containing the typed
  // text are listed ahead of search results.
  addressHistory: PlaceResult[];
}

// Suggestions are reported up to the parent, which renders the dropdown as a
// sibling of the draggable stop list so it isn't clipped by the list's ScrollView.
const AddressInput = ( {
  placeholder,
  value,
  onChangeText,
  onSuggestionsChange,
  confirmed,
  dotColor,
  nearbyLatLng,
  onEmptyBlur,
  presetSuggestions,
  addressHistory,
}: AddressInputProps ) => {
  const [searching, setSearching] = useState( false );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>( null );
  // Guards against a stale, slow-to-resolve search (from earlier text, or from
  // before this field lost focus) clobbering the currently relevant suggestions.
  const requestIdRef = useRef( 0 );

  const handleChange = useCallback( ( text: string ) => {
    onChangeText( text );
    if ( debounceRef.current ) clearTimeout( debounceRef.current );
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const query = text.trim();
    // Before anything is typed, offer recent addresses and current location.
    if ( query.length === 0 ) {
      onSuggestionsChange( presetSuggestions );
      return;
    }
    const lowerQuery = query.toLowerCase();
    const historyMatches = addressHistory
      .filter( a => a.display_name.toLowerCase().includes( lowerQuery ) )
      .slice( 0, RECENT_ADDRESS_COUNT );
    onSuggestionsChange( historyMatches );
    if ( query.length < 3 ) return;
    debounceRef.current = setTimeout( async () => {
      setSearching( true );
      const results = await searchPlaces( query, nearbyLatLng );
      setSearching( false );
      if ( requestIdRef.current !== requestId ) return;
      const matchedNames = new Set( historyMatches.map( a => a.display_name ) );
      onSuggestionsChange( [
        ...historyMatches,
        ...results.filter( r => !matchedNames.has( r.display_name ) ),
      ] );
    }, 200 );
  }, [onChangeText, nearbyLatLng, onSuggestionsChange, presetSuggestions, addressHistory] );

  const handleClear = useCallback( () => {
    handleChange( "" );
  }, [handleChange] );

  const handleBlur = useCallback( () => {
    requestIdRef.current += 1;
    if ( value.trim().length === 0 ) onEmptyBlur?.();
  }, [value, onEmptyBlur] );

  return (
    <View className="flex-1">
      <TouchableOpacity
        accessibilityRole="button"
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
          accessibilityLabel="Text input field"
          className="flex-1 text-darkGray"
          placeholder={placeholder}
          value={value}
          onChangeText={handleChange}
          onFocus={handleClear}
          onBlur={handleBlur}
          autoCorrect={false}
          autoCapitalize="none"
          editable
        />
        {searching && <ActivityIndicator size={16} />}
        {confirmed && !searching && (
          <INatIcon name="checkmark" size={16} color={colors.inatGreen} />
        )}
      </TouchableOpacity>
    </View>
  );
};

type Props = Partial<TabStackScreenProps<"WildlifeHotspots">> & {
  // When embedded inline as an Explore view (rather than navigated to as its
  // own screen), the filter params are passed directly and the screen skips
  // its own safe-area wrapper since the host already provides one.
  embedded?: boolean;
  filterParams?: Record<string, unknown>;
  // Explore filters the observation-count links carry over, with the location
  // replaced by the hotspot
  exploreState?: object;
};

// Used only until the hidden measurement view below reports the real height.
const FALLBACK_HOTSPOT_CARD_HEIGHT = 200;
// Guards against the measured height being clipped by sub-pixel rounding and
// the panel's top border.
const HOTSPOT_CARD_HEIGHT_BUFFER = 12;

const styles = StyleSheet.create( {
  stopInputsContainer: {
    zIndex: 10,
  },
  hiddenHotspotMeasure: {
    position: "absolute",
    opacity: 0,
  },
} );

const WildlifeHotspotsScreen = ( {
  route, embedded, filterParams: filterParamsProp, exploreState,
}: Props ) => {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const setExploreView = useStore( state => state.setExploreView );
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { hasBottomTabBar } = useStackHost();
  // The bottom tab bar already pads the home indicator, so adding the inset
  // again here would just show as an empty grey bar below the hotspot card.
  const bottomInset = hasBottomTabBar
    ? 0
    : insets.bottom;
  const mapRef = useRef<MapView>( null );
  const carouselRef = useRef<ICarouselInstance>( null );
  // Index the carousel was scrolled to programmatically (by tapping a map
  // marker), so the resulting snap doesn't redo the selection work.
  const programmaticScrollIndexRef = useRef<number | null>( null );
  // Memoized on content so the reference is stable across renders (the
  // embedded Explore view passes a new object every render). It's a dependency
  // of the findHotspots effect below, which sets state, so a new reference each
  // render would loop ("Maximum update depth exceeded").
  const rawFilterParams = filterParamsProp ?? route?.params?.filterParams;
  const filterParamsKey = JSON.stringify( rawFilterParams ?? {} );
  const filterParams = useMemo(
    () => rawFilterParams ?? {},
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterParamsKey],
  );

  const [stops, setStops] = useState<Stop[]>( [
    { id: makeStopId(), text: "", point: null },
    { id: makeStopId(), text: "", point: null },
  ] );
  const [userLocation, setUserLocation] = useState<LatLng | null>( null );
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>( null );
  const [hotspotRouteCoords, setHotspotRouteCoords] = useState<RoutePoint[]>( [] );
  const [hotspotRouteLoading, setHotspotRouteLoading] = useState( false );
  const [activeSuggestions, setActiveSuggestions] = useState<{
    stopId: string;
    suggestions: PlaceResult[];
  } | null>( null );
  const [hotspotCardHeight, setHotspotCardHeight] = useState<number | null>( null );
  // Stops the user has focused or typed in, which the late-arriving initial
  // location fix must not overwrite.
  const editedStopIdsRef = useRef( new Set<string>() );

  const addressHistory = useStore( state => state.layout.hotspotAddressHistory );
  const addHotspotAddress = useStore( state => state.layout.addHotspotAddress );

  const {
    hotspots, routeCoords, loading, error, findHotspots,
  } = useRouteHotspots();

  // Rows shown in the dropdown before the user types: current location first,
  // then the most recent addresses.
  const presetSuggestions: PlaceResult[] = useMemo( () => [
    ...( userLocation
      ? [{
        place_id: CURRENT_LOCATION_PLACE_ID,
        display_name: t( "Current-location" ),
        lat: String( userLocation.latitude ),
        lon: String( userLocation.longitude ),
      }]
      : [] ),
    ...addressHistory.slice( 0, RECENT_ADDRESS_COUNT ),
  ], [userLocation, addressHistory, t] );

  const confirmedStopPoints = stops
    .filter( s => s.point )
    .map( s => ( {
      latitude: ( s.point as LatLng ).latitude,
      longitude: ( s.point as LatLng ).longitude,
    } ) );

  useEffect( () => {
    const initializeLocation = async () => {
      // A recent tracked fix is available instantly; a fresh accurate fix can
      // take seconds
      const loc = await getLatestTrackedLocation() ?? await fetchAccurateUserLocation();
      if ( loc ) {
        const latLng = { latitude: loc.latitude, longitude: loc.longitude };
        setUserLocation( latLng );
        setStops( prev => prev.map( s => ( editedStopIdsRef.current.has( s.id )
          ? s
          : { ...s, point: latLng, text: t( "Current-location" ) } ) ) );
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
      edgePadding: {
        top: 60, right: 40, bottom: 60, left: 40,
      },
      animated: true,
    } );
  }, [routeCoords, hotspots] );

  const handleStopTextChange = useCallback( ( id: string, text: string ) => {
    editedStopIdsRef.current.add( id );
    setStops( prev => prev.map( s => ( s.id === id
      ? { ...s, text, point: null }
      : s ) ) );
  }, [] );

  const handleSelectStopSuggestion = useCallback( ( id: string, result: PlaceResult ) => {
    setActiveSuggestions( null );
    Keyboard.dismiss();
    // Every suggestion — searched, recent, or current location — carries its
    // own coordinates, so the stop is confirmed as soon as it's picked.
    const point: LatLng | null = result.lat && result.lon
      ? { latitude: parseFloat( result.lat ), longitude: parseFloat( result.lon ) }
      : null;
    setStops( prev => prev.map( s => ( s.id === id
      ? { ...s, text: result.display_name, point }
      : s ) ) );
    if ( !point ) return;
    // Remember searched addresses (but not the synthetic current-location row)
    // so they can be offered again before typing next time.
    if ( result.place_id !== CURRENT_LOCATION_PLACE_ID ) {
      addHotspotAddress( {
        place_id: result.place_id,
        display_name: result.display_name,
        lat: String( point.latitude ),
        lon: String( point.longitude ),
      } );
    }
  }, [addHotspotAddress] );

  const handleStopSuggestionsChange = useCallback( (
    stopId: string,
    suggestions: PlaceResult[],
  ) => {
    setActiveSuggestions( prev => {
      if ( suggestions.length > 0 ) return { stopId, suggestions };
      return prev?.stopId === stopId
        ? null
        : prev;
    } );
  }, [] );

  const handleStopEmptyBlur = useCallback( ( id: string ) => {
    if ( !userLocation ) return;
    setStops( prev => prev.map( s => ( s.id === id
      ? { ...s, text: t( "Current-location" ), point: userLocation }
      : s ) ) );
  }, [userLocation, t] );

  const handleRemoveStop = useCallback( ( id: string ) => {
    setStops( prev => ( prev.length > 2
      ? prev.filter( s => s.id !== id )
      : prev ) );
    setActiveSuggestions( null );
  }, [] );

  const handleAddStopAfter = useCallback( ( id: string ) => {
    setStops( prev => {
      const idx = prev.findIndex( s => s.id === id );
      if ( idx === -1 ) return prev;
      const newStop: Stop = { id: makeStopId(), text: "", point: null };
      return [...prev.slice( 0, idx + 1 ), newStop, ...prev.slice( idx + 1 )];
    } );
    setActiveSuggestions( null );
  }, [] );

  const handleReorderStops = useCallback( ( { data }: { data: Stop[] } ) => {
    setStops( data );
    setActiveSuggestions( null );
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
    setSelectedHotspotId( isDeselecting
      ? null
      : hotspot.id );
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
          edgePadding: {
            top: 60, right: 40, bottom: 60, left: 40,
          },
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
    const newStop: Stop = {
      id: makeStopId(), text: t( "Hotspot" ), point: via, fromHotspot: true,
    };
    setStops( prev => [...prev.slice( 0, insertIdx ), newStop, ...prev.slice( insertIdx )] );
    setSelectedHotspotId( null );
    setHotspotRouteCoords( [] );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, t] );

  const hotspotStopPoints = useMemo(
    () => stops.flatMap( s => ( s.fromHotspot && s.point
      ? [s.point]
      : [] ) ),
    [stops],
  );
  const isHotspotOnRoute = useCallback(
    ( hotspot: Hotspot ) => hotspotStopPoints.some( pt => isAtPoint( hotspot, pt ) ),
    [hotspotStopPoints],
  );

  const handleHotspotSwipe = useCallback( ( index: number ) => {
    if ( programmaticScrollIndexRef.current === index ) {
      programmaticScrollIndexRef.current = null;
      return;
    }
    programmaticScrollIndexRef.current = null;
    const hotspot = hotspots[index];
    if ( hotspot && hotspot.id !== selectedHotspotId ) {
      handleHotspotPress( hotspot );
    }
  }, [hotspots, selectedHotspotId, handleHotspotPress] );

  // Tapping a hotspot marker slides the card carousel to that hotspot's pane.
  const handleHotspotMarkerPress = useCallback( ( hotspot: Hotspot, index: number ) => {
    if ( selectedHotspotId !== hotspot.id ) {
      programmaticScrollIndexRef.current = index;
      carouselRef.current?.scrollTo( { index, animated: true } );
    }
    handleHotspotPress( hotspot );
  }, [selectedHotspotId, handleHotspotPress] );

  useEffect( () => {
    setHotspotCardHeight( null );
    if ( hotspots.length > 0 ) {
      handleHotspotPress( hotspots[0] );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotspots] );

  // Card height is driven by the number of top-species rows, so the hotspot
  // with the most rows is the tallest. Measuring that one (rather than the
  // visible one) keeps the bottom panel a fixed height as the user swipes.
  const tallestHotspot = useMemo( () => hotspots.reduce(
    ( tallest, hotspot ) => ( hotspot.topSpecies.length > tallest.topSpecies.length
      ? hotspot
      : tallest ),
    hotspots[0],
  ), [hotspots] );

  const handleObservationPress = useCallback( ( uuid: string ) => {
    navigation.push( "ObsDetails", { uuid } );
  }, [navigation] );

  // Opens the observations map in Explore with the current filters, zoomed
  // to the hotspot, and optionally narrowed to one species
  const openHotspotInExplore = useCallback( (
    hotspot: Hotspot,
    species?: HotspotSpecies,
  ) => {
    setExploreView( "observations" );
    zustandStorage.setItem( "exploreObservationsLayout", "map" );
    // Otherwise the map restores the last viewport instead of the hotspot
    useStore.setState( state => ( {
      layout: { ...state.layout, lastExploreMapRegion: null },
    } ) );
    navigation.navigate( "Explore", {
      exploreState,
      ...( species && {
        taxon: {
          id: species.id,
          name: species.name,
          preferred_common_name: species.preferred_common_name,
        },
      } ),
      lat: hotspot.centerLatitude,
      lng: hotspot.centerLongitude,
      // Rounded up (with a floor for single-point clusters) so the circle
      // still contains the cluster's farthest observation
      radius: Math.max( 0.1, Math.ceil( hotspot.radiusKm * 100 ) / 100 ),
      worldwide: false,
    } );
  }, [navigation, exploreState, setExploreView] );

  const handleSpeciesCountPress = useCallback(
    ( hotspot: Hotspot, species: HotspotSpecies ) => openHotspotInExplore( hotspot, species ),
    [openHotspotInExplore],
  );

  const handleObservationCountPress = useCallback(
    ( hotspot: Hotspot ) => openHotspotInExplore( hotspot ),
    [openHotspotInExplore],
  );

  const renderStopItem = useCallback( ( {
    item: stop, getIndex, drag, isActive,
  }: RenderItemParams<Stop> ) => {
    const index = getIndex() ?? 0;
    return (
      <ScaleDecorator>
        <View
          className={`flex-row items-center bg-white ${index < stops.length - 1
            ? "mb-2"
            : ""}`}
          // eslint-disable-next-line react-native/no-inline-styles
          style={{
            zIndex: stops.length - index,
            opacity: isActive
              ? 0.7
              : 1,
          }}
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
            placeholder={stopPlaceholder( index, stops.length, t )}
            value={stop.text}
            onChangeText={text => handleStopTextChange( stop.id, text )}
            onSuggestionsChange={suggestions => handleStopSuggestionsChange( stop.id, suggestions )}
            confirmed={!!stop.point}
            dotColor={stopDotColor( index, stops.length )}
            nearbyLatLng={stops[index - 1]?.point ?? userLocation ?? undefined}
            onEmptyBlur={() => handleStopEmptyBlur( stop.id )}
            presetSuggestions={presetSuggestions}
            addressHistory={addressHistory}
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
          <TouchableOpacity
            onPress={() => handleAddStopAfter( stop.id )}
            className="ml-2 p-1"
            accessibilityRole="button"
            accessibilityLabel={t( "Add-stop" )}
          >
            <INatIcon name="plus" size={16} color={colors.inatGreen} />
          </TouchableOpacity>
        </View>
      </ScaleDecorator>
    );
  }, [
    stops,
    userLocation,
    t,
    presetSuggestions,
    addressHistory,
    handleStopTextChange,
    handleStopSuggestionsChange,
    handleStopEmptyBlur,
    handleRemoveStop,
    handleAddStopAfter,
  ] );

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

  const content = (
    <>
      {/* Stop inputs */}
      <View
        className="bg-white px-3 py-2 border-b border-lightGray"
        style={styles.stopInputsContainer}
      >
        <DraggableFlatList
          data={stops}
          keyExtractor={stop => stop.id}
          renderItem={renderStopItem}
          onDragEnd={handleReorderStops}
          scrollEnabled={false}
        />
        {/*
          Rendered in normal flow (not absolutely positioned) as a sibling of the
          draggable list so it can't be clipped by the list's ScrollView, hidden
          behind the map, or mispositioned by a stale measured offset.
        */}
        {activeSuggestions && (
          <View className="mt-1 bg-white border border-lightGray rounded-lg overflow-hidden">
            {activeSuggestions.suggestions.map( result => (
              <TouchableOpacity
                accessibilityRole="button"
                key={result.place_id}
                className="px-3 py-2 border-b border-lightGray"
                onPress={() => handleSelectStopSuggestion( activeSuggestions.stopId, result )}
              >
                <Body3 numberOfLines={2}>{result.display_name}</Body3>
              </TouchableOpacity>
            ) )}
          </View>
        )}
      </View>

      {/* Map */}
      <View className="flex-1">
        <Map
          ref={mapRef}
          initialRegion={INITIAL_REGION}
          showCurrentLocationButton
          showScaleBar
          showSwitchMapTypeButton
          showsUserLocation
          mapChildren={(
            <>
              {stops.map( ( stop, index ) => {
                const { point } = stop;
                if ( !point ) return null;
                // Hotspot stops are shown by the numbered hotspot pin instead
                if ( stop.fromHotspot && hotspots.some( h => isAtPoint( h, point ) ) ) {
                  return null;
                }
                return (
                  <Marker
                    key={stop.id}
                    coordinate={point}
                    pinColor={stopDotColor( index, stops.length )}
                    title={stop.text || `${t( "Stop-noun" )} ${index + 1}`}
                  />
                );
              } )}
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
              {hotspots.map( ( hotspot, idx ) => (
                <Marker
                  key={hotspot.id}
                  coordinate={{
                    latitude: hotspot.centerLatitude,
                    longitude: hotspot.centerLongitude,
                  }}
                  anchor={{ x: 0.5, y: 0.5 }}
                  onPress={() => handleHotspotMarkerPress( hotspot, idx )}
                >
                  <View
                    className="w-6 h-6 rounded-full items-center justify-center border border-white"
                    style={{
                      backgroundColor: selectedHotspotId === hotspot.id
                        ? colors.inatGreen
                        : colors.warningYellow,
                    }}
                  >
                    <Body4 className="text-white font-bold">{idx + 1}</Body4>
                  </View>
                </Marker>
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
            </>
          )}
        />

        {( loading || hotspotRouteLoading ) && (
          <View
            className={"absolute top-0 left-0 right-0 bottom-0 "
              + "items-center justify-center bg-white/60"}
          >
            <ActivityIndicator size={48} />
            <Body2 className="mt-3 text-darkGray">
              {loading
                ? t( "Searching-for-hotspots" )
                : t( "Loading-route" )}
            </Body2>
          </View>
        )}
      </View>

      {/* Hidden copy of the tallest hotspot card, used only to measure the
          height the section below should hold for every card in the set. */}
      {tallestHotspot && (
        <View
          style={[styles.hiddenHotspotMeasure, { width: windowWidth }]}
          pointerEvents="none"
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onLayout={( { nativeEvent } ) => {
            const measured = Math.ceil( nativeEvent.layout.height ) + HOTSPOT_CARD_HEIGHT_BUFFER;
            // Never shrink within a result set, so a late or slightly smaller
            // measurement can't nudge the panel up and down.
            setHotspotCardHeight( prev => Math.max( prev ?? 0, measured ) );
          }}
        >
          <HotspotListItem
            hotspot={tallestHotspot}
            rank={1}
            selected={false}
            onPress={() => null}
            onOpenInGoogleMaps={() => null}
            onAddToRoute={() => null}
          />
        </View>
      )}

      {/* Hotspot cards */}
      {( hotspots.length > 0 || error ) && (
        <View
          className="bg-lightGray border-t border-lightGray"
          // Add the bottom safe-area inset so the card's action buttons clear
          // the home indicator; the extra height keeps the carousel content
          // region at the full measured card height. When a bottom tab bar is
          // present it already covers that area, so the inset is zero.
          style={{
            height: ( hotspotCardHeight ?? FALLBACK_HOTSPOT_CARD_HEIGHT ) + bottomInset,
            paddingBottom: bottomInset,
          }}
        >
          {error
            ? (
              <View className="p-4 items-center">
                <Body2 className="text-darkGray text-center">{error}</Body2>
              </View>
            )
            : (
              <Carousel
                ref={carouselRef}
                key={`WildlifeHotspotsCarousel-${windowWidth}-${hotspots.length}`}
                testID="WildlifeHotspotsScreen.carousel"
                data={hotspots}
                width={windowWidth}
                loop={false}
                onSnapToItem={handleHotspotSwipe}
                renderItem={( { item: hotspot, index } ) => (
                  <View className="flex-1">
                    <HotspotListItem
                      hotspot={hotspot}
                      rank={index + 1}
                      selected={selectedHotspotId === hotspot.id}
                      onPress={() => handleHotspotPress( hotspot )}
                      onOpenInGoogleMaps={() => handleOpenInGoogleMaps( hotspot )}
                      onAddToRoute={isHotspotOnRoute( hotspot )
                        ? undefined
                        : () => handleAddHotspotToRoute( hotspot )}
                      onSpeciesCountPress={species => handleSpeciesCountPress( hotspot, species )}
                      onObservationCountPress={() => handleObservationCountPress( hotspot )}
                    />
                  </View>
                )}
              />
            )}
        </View>
      )}
    </>
  );

  if ( embedded ) {
    return (
      <View className="flex-1" testID="WildlifeHotspotsScreen">
        {content}
      </View>
    );
  }

  return (
    <ViewWrapper testID="WildlifeHotspotsScreen">
      {content}
    </ViewWrapper>
  );
};

export default WildlifeHotspotsScreen;
