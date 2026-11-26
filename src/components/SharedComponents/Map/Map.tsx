import { useNetInfo } from "@react-native-community/netinfo";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import classnames from "classnames";
import { Body1 } from "components/SharedComponents";
import { View } from "components/styledComponents";
import { cssInterop } from "nativewind";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DimensionValue, LayoutChangeEvent, ViewStyle } from "react-native";
import { Platform } from "react-native";
import type {
  BoundingBox, LatLng, Region,
  UserLocationChangeEvent,
} from "react-native-maps";
import MapView, { UrlTile } from "react-native-maps";
import type Observation from "realmModels/Observation";
import fetchCoarseUserLocation from "sharedHelpers/fetchCoarseUserLocation";
import mapTracker from "sharedHelpers/mapPerformanceTracker";
import {
  OBSERVATION_TILE_CACHE_PATH,
  OBSERVATION_TILE_MAX_AGE_S,
  pruneObservationTileCache,
} from "sharedHelpers/observationTileCache";
import { useDebugMode, useDeviceOrientation } from "sharedHooks";
import useLocationPermission from "sharedHooks/useLocationPermission";
import type { MAP_TYPES } from "stores/createLayoutSlice";
import useStore from "stores/useStore";
import colors from "styles/tailwindColors";

import CurrentLocationButton from "./CurrentLocationButton";
import {
  calculateZoom,
  fetchObservationUUID,
  getMapBoundariesSafely,
  metersToLatitudeDelta,
  OBSCURATION_CELL_SIZE,
  obscurationCellForLatLng,
  regionForViewportWidth,
  TILE_URL,
} from "./helpers/mapHelpers";
import LocationIndicator from "./LocationIndicator";
import ObscuredLocationIndicator from "./ObscuredLocationIndicator";
import ScaleBar from "./ScaleBar";
import SwitchMapTypeButton from "./SwitchMapTypeButton";

// className support: third-party components need explicit registration with
// nativewind 4 for className to have any effect
cssInterop( MapView, { className: "style" } );

const NEARBY_DIM_M = 50_000;
// width of the viewport when the user hits the current location button
const CURRENT_LOCATION_VIEWPORT_WIDTH_M = 3_000;
const MIN_ZOOM_LEVEL = 0; // default in react-native-maps, for Google Maps only
const MIN_CENTER_COORDINATE_DISTANCE = 5;

// Params that never change which observations a tile shows: paging, sorting,
// and what the list asks for. The bounds of a map area search go too: tiles
// cover the whole map, so pins stay put and new ones fill in as the map pans,
// and the tile URL, with the tiles cached under it, stays the same for every
// area searched.
const NON_TILE_PARAMS = new Set( [
  "fields",
  "id_above",
  "id_below",
  "nelat",
  "nelng",
  "order",
  "order_by",
  "page",
  "per_page",
  "return_bounds",
  "swlat",
  "swlng",
  "ttl",
] );

// Android's tile layer blanks as soon as its URL changes, so the last search's
// tiles stay underneath while the new ones load. There's no event for when they
// have, so they go after this long online, and stay while offline. iOS keeps them
// natively (see patches/react-native-maps).
const PREVIOUS_TILES_MS = 8000;
const KEEPS_PREVIOUS_TILES = Platform.OS === "android";

const getDefaultRegion = ( initialLatitude?: number, initialLongitude?: number ) => ( {
  latitude: initialLatitude || 25, // Default to something US centric
  longitude: initialLongitude || -85, // Default to something US centric
  latitudeDelta: initialLatitude
    ? 0.2
    : 100,
  longitudeDelta: initialLatitude
    ? 0.2
    : 100,
} );

interface Props {
  // Bottom offset for the current-location and map-type buttons, e.g. to
  // keep them clear of the home indicator on a map that fills the screen
  buttonBottomOffset?: number;
  children?: React.ReactNode;
  mapChildren?: React.ReactNode;
  className?: string;
  currentLocationButtonClassName?: string;
  initialRegion?: Region;
  isLoading?: boolean;
  mapHeight?: DimensionValue; // allows for height to be defined as px or percentage
  mapViewClassName?: string;
  observation?: Observation;
  onCurrentLocationPress?: () => void;
  onMapReady?: () => void;
  onPanDrag?: () => void;
  onRegionChangeComplete?: ( _r: Region, _b: BoundingBox | undefined ) => void;
  openMapScreen?: () => void;
  ref?: React.Ref<MapView>;
  regionToAnimate?: Region;
  scrollEnabled?: boolean;
  showCurrentLocationButton?: boolean;
  showsCompass?: boolean;
  showSwitchMapTypeButton?: boolean;
  showsUserLocation?: boolean;
  style?: ViewStyle;
  switchMapTypeButtonClassName?: string;
  testID?: string;
  tileMapParams?: object | null;
  withObsTiles?: boolean;
  withPressableObsTiles?: boolean;
  zoomEnabled?: boolean;
  zoomTapEnabled?: boolean;
  onMapLayout?: ( event: LayoutChangeEvent ) => void;
  // Tile layers drawn under the observation tiles, e.g. a saved base map offline
  baseTiles?: React.ReactNode;
}

// TODO: fallback to another map library
// for people who don't use GMaps (i.e. users in China)
const Map = ( {
  buttonBottomOffset,
  children,
  mapChildren,
  className = "flex-1",
  currentLocationButtonClassName,
  initialRegion,
  isLoading = true,
  mapHeight,
  mapViewClassName,
  observation,
  onCurrentLocationPress,
  onMapReady = ( ) => undefined,
  onPanDrag = ( ) => undefined,
  onRegionChangeComplete,
  openMapScreen,
  ref,
  regionToAnimate,
  scrollEnabled = true,
  showCurrentLocationButton,
  showsCompass,
  showSwitchMapTypeButton,
  showsUserLocation: showsUserLocationProp,
  style,
  switchMapTypeButtonClassName,
  testID,
  tileMapParams,
  withObsTiles,
  withPressableObsTiles,
  zoomEnabled = true,
  zoomTapEnabled = true,
  onMapLayout,
  baseTiles,
}: Props ) => {
  const tilesMarkedVisible = useRef( false );
  const [performanceMetrics, setPerformanceMetrics] = useState( {
    mapReadyTime: 0,
    tilesVisibleTime: 0,
  } );
  const { isDebug } = useDebugMode( );
  const { screenWidth, screenHeight } = useDeviceOrientation( );
  // on iOS, onRegionChangeComplete does not fire when the map mounts with initialRegion
  // Until the map reports a region of its own, derive the zoom from the region we're mounting with.
  const [reportedZoom, setReportedZoom] = useState<number | null>( null );
  const currentZoom = reportedZoom ?? (
    initialRegion?.longitudeDelta
      ? calculateZoom( screenWidth, initialRegion.longitudeDelta )
      : 0
  );
  const [scaleRegion, setScaleRegion] = useState<Region | null>( null );
  const setLiveScaleRegion = useRef<( r: Region ) => void>( null );
  const handleRegionChange = useCallback(
    ( r: Region ) => setLiveScaleRegion.current?.( r ),
    [],
  );
  const navigation = useNavigation( );
  const { hasPermissions, renderPermissionsGate, requestPermissions } = useLocationPermission( );
  const [userLocation, setUserLocation] = useState<{
    accuracy: number;
    latitude: number;
    longitude: number;
  } | undefined | null>( null );
  const mapViewRef = useRef<MapView>( undefined );
  const mapType: MAP_TYPES = useStore( state => state.layout.mapType );
  const [showsUserLocation, setShowsUserLocation] = useState( showsUserLocationProp );
  // A map on a screen that's covered or on another tab stays mounted; stop its
  // location updates until it's visible again.
  const isFocused = useIsFocused( );

  let defaultInitialRegion = null;

  if ( observation ) {
    if ( observation.obscured && !observation.privateLatitude ) {
      const obscurationCell = obscurationCellForLatLng(
        observation.latitude,
        observation.longitude,
      );
      defaultInitialRegion = {
        latitude: obscurationCell.minLat + ( OBSCURATION_CELL_SIZE / 2 ),
        longitude: obscurationCell.minLng + ( OBSCURATION_CELL_SIZE / 2 ),
        latitudeDelta: 0.3,
        longitudeDelta: 0.3,
      };
    } else {
      defaultInitialRegion = getDefaultRegion(
        observation.privateLatitude || observation.latitude,
        observation.privateLongitude || observation.longitude,
      );
    }
  }

  // In Android, we maintain a state for defaultInitialRegion and initialRegion
  // that is updated on gestures like pan and zoom. This state is always null in iOS.
  const [androidLocalRegion, setAndroidLocalRegion] = useState<Region|null>(
    Platform.OS === "android"
      ? initialRegion || defaultInitialRegion
      : null,
  );

  // On Android, suppress the controlled region prop while the user is dragging
  // so the map doesn't fight the gesture or snap on release.
  const [isUserDragging, setIsUserDragging] = useState( false );
  // Ref so we only call setIsUserDragging/onPanDrag once per gesture, not on
  // every movement event that onPanDrag fires during the drag.
  const panDragActiveRef = useRef( false );

  // In Android, onMapReady does not fire when we pass parameter region instead
  // of parameter initialRegion. This state allows us to fire onMapReady and
  // fire it only once. This state is always false in iOS.
  const [onMapReadyHasFiredAndroid, setOnMapReadyHasFiredAndroid] = useState( false );

  // In Android, animateToRegion animates to the given region but the map then
  // immediately returns to the previous region. We fake a gesture to the
  // desired region to make it stick. This state stores the region for this
  // gesture. This state is always null in iOS.
  const [androidAnimateRegion, setAndroidAnimateRegion] = useState<Region|null>( null );

  // Measured size of the map, which isn't always the size of the screen
  const [mapSize, setMapSize] = useState<{ width: number; height: number } | null>( null );
  const handleMapLayout = ( event: LayoutChangeEvent ) => {
    const { width, height } = event.nativeEvent.layout;
    setMapSize( { width, height } );
    onMapLayout?.( event );
  };

  const animateToRegion = ( newRegion: Region ) => {
    mapViewRef.current?.animateToRegion( newRegion );
    if ( Platform.OS === "android" ) {
      setAndroidAnimateRegion( newRegion );
    }
  };

  useEffect( ( ) => {
    // in LocationPicker we're setting initialRegion to eliminate jitteriness
    // when scrolling, which means we also must use this method to reset the map
    // when searching for a location by typing a place name and selecting place coordinates
    if ( !regionToAnimate || !mapViewRef.current ) { return; }
    animateToRegion( {
      latitude: regionToAnimate.latitude,
      longitude: regionToAnimate.longitude,
      latitudeDelta: regionToAnimate.latitudeDelta,
      longitudeDelta: regionToAnimate.longitudeDelta,
    } );
  }, [
    regionToAnimate,
  ] );

  // In a stable order, so the same search always has the same tile URL
  const params = useMemo( ( ) => Object.fromEntries(
    Object.entries( tileMapParams || {} )
      .filter( ( [key, value] ) => !NON_TILE_PARAMS.has( key ) && value != null && value !== "" )
      .sort( ( [a], [b] ) => a.localeCompare( b ) ),
  ), [tileMapParams] );

  const onMapPressForObsLyr = useCallback( async ( latLng: LatLng ) => {
    const uuid = await fetchObservationUUID( currentZoom, latLng, params );
    if ( uuid ) {
      navigation.push( "ObsDetails", { uuid } );
    }
  }, [params, currentZoom, navigation] );

  const onPermissionGranted = async ( ) => {
    const currentLocation = await fetchCoarseUserLocation( );
    if ( currentLocation && mapViewRef?.current ) {
      animateToRegion( {
        latitude: currentLocation.latitude,
        longitude: currentLocation.longitude,
        latitudeDelta: metersToLatitudeDelta( NEARBY_DIM_M, currentLocation.latitude ),
        longitudeDelta: metersToLatitudeDelta( NEARBY_DIM_M, currentLocation.latitude ),
      } );
    }
  };

  const renderCurrentLocationPermissionsGate = () => renderPermissionsGate( {
    onPermissionGranted,
  } );

  // In Android, we always return a state, either region or androidLocalRegion,
  // unless the user is actively dragging (to avoid fighting the gesture).
  const setRegion = ( ) => {
    let region;
    if ( Platform.OS === "android" ) {
      region = isUserDragging
        ? undefined
        : androidLocalRegion;
    } else if ( !initialRegion ) {
      region = defaultInitialRegion;
    }
    return region;
  };

  const handleCurrentLocationPress = useCallback( ( ) => {
    if ( !hasPermissions ) {
      requestPermissions( );
    }
    // If we aren't showing the user's location, we won't have a location to
    // zoom to yet, so first we need to turn that on, and we'll re-call this
    // function in an effect when we have a location
    if ( !showsUserLocation ) {
      setShowsUserLocation( true );
      return;
    }
    // If we're supposed to be showing user location but we don't have it, ask
    // for permission again, which should result in fetching the location if
    // we can
    // skipping onCurrentLocationPress here because the handlers
    // are handling the permissions request outside of this component (example: Explore MapView)
    if ( !userLocation && onCurrentLocationPress === undefined ) {
      return;
    }
    if ( onCurrentLocationPress ) {
      onCurrentLocationPress( );
    }
    if ( userLocation && mapViewRef?.current ) {
      // Show a viewport CURRENT_LOCATION_VIEWPORT_WIDTH_M wide, with the
      // height following the map's aspect ratio
      const { latitudeDelta, longitudeDelta } = regionForViewportWidth(
        userLocation.latitude,
        CURRENT_LOCATION_VIEWPORT_WIDTH_M,
        mapSize?.width || screenWidth,
        mapSize?.height || screenHeight,
      );

      animateToRegion( {
        latitude: userLocation.latitude,
        longitude: userLocation.longitude,
        latitudeDelta,
        longitudeDelta,
      } );
    }
  }, [
    onCurrentLocationPress,
    hasPermissions,
    mapSize,
    requestPermissions,
    screenHeight,
    screenWidth,
    showsUserLocation,
    userLocation,
  ] );

  const mapContainerStyle = [
    mapHeight
      ? { height: mapHeight }
      : null,
  ];

  const mapContainerClass = classnames(
    "flex-1 h-full",
    mapViewClassName,
  );

  const cameraZoomRange = {
    minCenterCoordinateDistance: MIN_CENTER_COORDINATE_DISTANCE,
  };

  const handleUserLocationChange = async ( locationChangeEvent: UserLocationChangeEvent ) => {
    const coordinate = locationChangeEvent?.nativeEvent?.coordinate;
    setUserLocation( coordinate );
  };

  const queryString = Object.keys( params ).map( key => `${key}=${params[key]}` ).join( "&" );

  const showPointTiles = currentZoom > 13;

  // We want green points and (default) orange grid. The /heatmap endpoint's
  // density-to-color mapping isn't tied to a fixed scale, so pairing it with
  // a hardcoded color gradient made the colors look inconsistent between
  // zoom levels. /grid uses a fixed color scale tuned per zoom level, so it
  // stays visually consistent as you zoom in and out.
  const tileUrlTemplate = showPointTiles
    ? `${TILE_URL}/points/{z}/{x}/{y}.png?${queryString}&color=%2374ac00`
    : `${TILE_URL}/grid/{z}/{x}/{y}.png?${queryString}`;

  const { isConnected } = useNetInfo( );
  const isOffline = isConnected === false;
  // The template shown, and on Android the one before it, kept underneath
  // until the new tiles have had time to load. Updated while rendering, so the
  // old layer never unmounts in between.
  const [tileLayers, setTileLayers] = useState<{
    current: string;
    previous: string | null;
  }>( { current: tileUrlTemplate, previous: null } );
  if ( tileLayers.current !== tileUrlTemplate ) {
    setTileLayers( {
      current: tileUrlTemplate,
      previous: KEEPS_PREVIOUS_TILES
        ? tileLayers.current
        : null,
    } );
  }
  const previousTileTemplate = tileLayers.previous;
  useEffect( ( ) => {
    if ( !previousTileTemplate || isOffline ) return ( ) => undefined;
    const timer = setTimeout(
      ( ) => setTileLayers( layers => ( { ...layers, previous: null } ) ),
      PREVIOUS_TILES_MS,
    );
    return ( ) => clearTimeout( timer );
  }, [previousTileTemplate, isOffline] );

  const handleRegionChangeComplete = useCallback( async (
    newRegion: Region,
    { isGesture }: { isGesture?: boolean },
  ) => {
    // We are only interested in region changes due to user interaction.
    // In Android, onRegionChangeComplete also fires for other map region
    // changes and gesture.isGesture is available to test for user interaction.
    let shouldSkipRegionUpdate = false;
    if ( Platform.OS === "android" && !isGesture ) {
      if ( !onMapReadyHasFiredAndroid && onMapReady ) {
        setOnMapReadyHasFiredAndroid( true );
        onMapReady();
      }
      shouldSkipRegionUpdate = true;
    }
    panDragActiveRef.current = false;
    if ( isUserDragging ) {
      setIsUserDragging( false );
    }
    if ( !shouldSkipRegionUpdate ) {
      if ( onRegionChangeComplete ) {
        const boundaries = await getMapBoundariesSafely( mapViewRef?.current );
        onRegionChangeComplete( newRegion, boundaries );
      }
      if ( androidLocalRegion ) {
        setAndroidLocalRegion( newRegion );
      }
    }
    setReportedZoom( calculateZoom( screenWidth, newRegion.longitudeDelta ) );
    setScaleRegion( newRegion );
  }, [
    onMapReadyHasFiredAndroid,
    onMapReady,
    onRegionChangeComplete,
    androidLocalRegion,
    isUserDragging,
    screenWidth,
  ] );

  // In Android, animateToRegion animates to the given region but the map then
  // immediately returns to the previous region. We fake a gesture to the
  // desired region to make it stick.
  useEffect(
    ( ) => {
      if ( Platform.OS === "android" && androidAnimateRegion ) {
        const newRegion = {
          ...androidLocalRegion, // provides defaults for latitudeDelta and longitudeDelta
          ...androidAnimateRegion,
        };
        setTimeout(
          ( ) => handleRegionChangeComplete( newRegion, { isGesture: true } ),
        );
        setAndroidAnimateRegion( null );
      }
    },
    [
      androidAnimateRegion,
      androidLocalRegion,
      handleRegionChangeComplete,
    ],
  );

  const handlePanDrag = useCallback( ( ) => {
    if ( panDragActiveRef.current ) return;
    panDragActiveRef.current = true;
    if ( Platform.OS === "android" ) {
      setIsUserDragging( true );
    }
    onPanDrag( );
  }, [onPanDrag] );

  const handleMapPress = e => {
    if ( withPressableObsTiles ) onMapPressForObsLyr( e.nativeEvent.coordinate );
    else if ( openMapScreen ) {
      openMapScreen( );
    }
  };

  const shouldOverlayObsTiles = withPressableObsTiles || withObsTiles;

  useEffect( ( ) => {
    if ( shouldOverlayObsTiles ) pruneObservationTileCache( );
  }, [shouldOverlayObsTiles] );

  const renderObsTiles = ( urlTemplate: string, isPrevious: boolean ) => (
    <UrlTile
      // Android keeps a layer per template, so an old one stays mounted
      // under a new one. On iOS one layer changes template in place, which
      // keeps the old tiles natively, but has to be added again after base
      // tiles to stay on top of them.
      key={KEEPS_PREVIOUS_TILES
        ? urlTemplate
        : `obsTiles-${!!baseTiles}`}
      testID={isPrevious
        ? "Map.UrlTile.previous"
        : "Map.UrlTile"}
      tileSize={512}
      urlTemplate={urlTemplate}
      opacity={1}
      zIndex={isPrevious
        ? 0
        : 1}
      tileCachePath={OBSERVATION_TILE_CACHE_PATH}
      tileCacheMaxAge={OBSERVATION_TILE_MAX_AGE_S}
      offlineMode={isOffline}
    />
  );

  const mapRegion = setRegion( );

  const renderDebugZoomLevel = ( ) => {
    if ( isDebug ) {
      return (
        <View
          className={classnames(
            "absolute",
            "left-5",
            "bottom-[140px]",
            "bg-deeppink",
            "p-1",
            "z-10",
          )}
        >
          <Body1 className="text-white">
            {`Zoom: ${currentZoom}`}
          </Body1>
        </View>
      );
    }
    return null;
  };

  const currentUserCanViewCoords = observation && !!(
    !observation.obscured || observation.privateLatitude
  );

  const latitude = observation?.privateLatitude || observation?.latitude;
  const longitude = observation?.privateLongitude || observation?.longitude;
  const hasCoordinates = latitude && longitude;

  const setRefs = instance => {
    // Update our internal ref
    mapViewRef.current = instance;

    // Forward to the parent ref
    if ( typeof ref === "function" ) {
      ref( instance );
    } else if ( ref ) {
      ref.current = instance;
    }
  };

  const handleMapReady = ( ) => {
    mapTracker.markMapReady( );

    if ( onMapReady ) {
      onMapReady( );
    }
  };

  useEffect( ( ) => {
    // debug mode only: display performance metrics
    // eslint-disable-next-line no-undef
    if ( isDebug ) {
      mapTracker.reset( );

      const updateInterval = setInterval( ( ) => {
        const metrics = mapTracker.getSummary( );
        setPerformanceMetrics( metrics );
      }, 500 );

      return ( ) => {
        clearInterval( updateInterval );
      };
    }
    return () => undefined;
  }, [isDebug] );

  useEffect( ( ) => {
    // Detect when tiles are likely to be visible based on key conditions,
    // since we can't get this info directly from UrlTile
    if ( isDebug
        && currentZoom > 0
        && shouldOverlayObsTiles
        && !isLoading
        && !tilesMarkedVisible.current ) {
      // Add a small delay to ensure tiles have had time to render --
      // I wouldn't call this super accurate but it was helpful enough for a ballpark
      // and to get an idea of the average time it takes to load tiles
      setTimeout( ( ) => {
        mapTracker.markTilesVisible( );
        tilesMarkedVisible.current = true;
      }, 300 );
    }
  }, [currentZoom, shouldOverlayObsTiles, isLoading, isDebug] );

  return (
    <View
      style={mapContainerStyle}
      testID="MapView"
      className={mapContainerClass}
      onLayout={handleMapLayout}
    >
      {renderDebugZoomLevel( )}
      <MapView
        cameraZoomRange={cameraZoomRange}
        className={className}
        initialRegion={initialRegion}
        loadingEnabled
        loadingIndicatorColor={colors.inatGreen}
        mapType={mapType}
        minZoomLevel={MIN_ZOOM_LEVEL}
        onMapReady={handleMapReady}
        onPanDrag={handlePanDrag}
        onPress={handleMapPress}
        onRegionChange={handleRegionChange}
        onRegionChangeComplete={handleRegionChangeComplete}
        onUserLocationChange={handleUserLocationChange}
        pitchEnabled={false}
        ref={setRefs}
        // TODO: reconcile possible `null` state
        region={mapRegion}
        rotateEnabled={false}
        scrollEnabled={scrollEnabled}
        showsCompass={showsCompass}
        showsMyLocationButton={false}
        showsUserLocation={showsUserLocation && hasPermissions && isFocused}
        style={style}
        testID={testID || "Map.MapView"}
        zoomEnabled={zoomEnabled}
        zoomTapEnabled={zoomTapEnabled}
      >
        {baseTiles}
        { shouldOverlayObsTiles && previousTileTemplate
          && renderObsTiles( previousTileTemplate, true )}
        { shouldOverlayObsTiles && renderObsTiles( tileUrlTemplate, false )}
        { observation && hasCoordinates && ( currentUserCanViewCoords
          ? (
            <LocationIndicator
              latitude={latitude}
              longitude={longitude}
              positionalAccuracy={observation.positional_accuracy}
            />
          )
          : (
            <ObscuredLocationIndicator
              latitude={latitude}
              longitude={longitude}
            />
          )
        ) }
        {mapChildren}
      </MapView>
      <CurrentLocationButton
        bottomOffset={buttonBottomOffset}
        showCurrentLocationButton={showCurrentLocationButton}
        currentLocationButtonClassName={currentLocationButtonClassName}
        hasPermissions={hasPermissions}
        renderPermissionsGate={renderCurrentLocationPermissionsGate}
        requestPermissions={requestPermissions}
        onPermissionGranted={onPermissionGranted}
        onPress={handleCurrentLocationPress}
      />
      <ScaleBar
        region={scaleRegion || mapRegion || initialRegion}
        mapWidth={mapSize?.width || screenWidth}
        liveRegionRef={setLiveScaleRegion}
      />
      <SwitchMapTypeButton
        bottomOffset={buttonBottomOffset}
        mapType={mapType}
        showSwitchMapTypeButton={showSwitchMapTypeButton}
        switchMapTypeButtonClassName={switchMapTypeButtonClassName}
      />
      {children}
      {isDebug && (
        <View
          className={classnames(
            "absolute",
            "left-5",
            "bottom-[280px]",
            "bg-deeppink",
            "p-1",
            "z-10",
          )}
        >
          <Body1 className="text-white">
            {`Map Ready: ${performanceMetrics.mapReadyTime}ms`}
          </Body1>
          <Body1 className="text-white">
            {`Tiles Visible: ${performanceMetrics.tilesVisibleTime > 0
              ? `${performanceMetrics.tilesVisibleTime}ms`
              : "Not yet visible"}`}
          </Body1>
        </View>
      )}
    </View>
  );
};

export default Map;
