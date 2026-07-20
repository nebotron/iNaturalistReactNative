import { useNavigation } from "@react-navigation/native";
import {
  accuracyToEncompassBounds,
  boundingBoxGeojsonToBounds,
  getMapRegion,
  hasValidMapCoordinates,
  latitudeDeltaToMeters,
  regionForAccuracy,
  regionForObservationLocation,
} from "components/SharedComponents/Map/helpers/mapHelpers";
import React, {
  useCallback,
  useEffect,
  useReducer,
  useState,
} from "react";
import type { LayoutChangeEvent } from "react-native";
import type { Region } from "react-native-maps";
import fetchPlaceName from "sharedHelpers/fetchPlaceName";
import useStore from "stores/useStore";

import LocationPicker from "./LocationPicker";
import type { LocationPickerObservation, LocationPickerPlace } from "./types";

const CROSSHAIRRADIUS = 254 / 2;

const initializeMap = ( state, action ) => {
  // Only initialize the map once. Re-initializing on later focus events or
  // dependency changes (e.g. when currentObservation is a live Realm object
  // whose reference changes) would discard the location the user has already
  // picked, snapping the crosshair back to the original location.
  if ( state.initialized ) {
    return state;
  }

  const {
    currentObservation,
    lastLocationPickerState,
    radiusToMapHeight,
    mapDimensionsRatio,
  } = action;

  let region = regionForObservationLocation(
    currentObservation,
    radiusToMapHeight,
    mapDimensionsRatio,
  );
  let accuracy = currentObservation?.positional_accuracy;
  let locationName = currentObservation?.place_guess ?? "";

  if ( !region && lastLocationPickerState?.region ) {
    const { region: savedRegion, accuracy: savedAccuracy, locationName: savedLocationName } = (
      lastLocationPickerState
    );
    region = savedRegion;
    accuracy = savedAccuracy ?? accuracy;
    locationName = savedLocationName ?? locationName;
  }

  const newMap = {
    ...state,
    accuracy: accuracy ?? 0,
    locationName,
    hidePlaceResults: true,
    initialized: true,
  };

  if ( region ) {
    newMap.region = region;
    newMap.regionToAnimate = region;
  }

  return newMap;
};

const initialState = {
  accuracy: 0,
  hidePlaceResults: true,
  initialized: false,
  isFirstMapRender: true,
  loading: true,
  locationName: "",
  region: undefined,
  regionToAnimate: undefined,
};

const reducer = ( state, action ) => {
  switch ( action.type ) {
    case "HANDLE_CURRENT_LOCATION_PRESS":
      return {
        ...state,
        loading: true,
        isFirstMapRender: false,
      };
    case "HANDLE_FIRST_MAP_RENDER":
      return {
        ...state,
        isFirstMapRender: false,
        loading: false,
      };
    case "HANDLE_MAP_READY":
      return {
        ...state,
        loading: false,
      };
    case "HANDLE_REGION_CHANGE":
      return {
        ...state,
        locationName: action.locationName,
        region: action.region,
        accuracy: action.accuracy,
        loading: false,
      };
    case "INITIALIZE_MAP": {
      const newMap = initializeMap( state, action );
      return newMap;
    }
    case "SELECT_PLACE_RESULT":
      return {
        ...state,
        locationName: action.locationName,
        region: action.region,
        accuracy: action.accuracy ?? state.accuracy,
        hidePlaceResults: true,
        regionToAnimate: action.regionToAnimate ?? action.region,
        loading: true,
        isFirstMapRender: false,
      };
    case "UPDATE_LOCATION_NAME":
      return {
        ...state,
        locationName: action.locationName,
        hidePlaceResults: false,
      };
    default:
      throw new Error( );
  }
};

interface SavedLocation {
  latitude: number;
  longitude: number;
  positional_accuracy: number;
  place_guess: string;
}

interface ContainerProps {
  // Use this observation instead of the store's currentObservation (e.g. the
  // location history flow, which edits a specific saved observation).
  observation?: LocationPickerObservation;
  // Called with the chosen location instead of writing back to the store.
  // Receives { latitude, longitude, positional_accuracy, place_guess } and is
  // responsible for any navigation afterwards.
  onSave?: ( _location: SavedLocation ) => void;
  // Extra markers/overlays rendered inside and on top of the map.
  mapChildren?: React.ReactNode;
  legend?: React.ReactNode;
}

const LocationPickerContainer = ( {
  observation: observationProp,
  onSave,
  mapChildren,
  legend,
}: ContainerProps ) => {
  const currentObservationFromStore = useStore( state => state.currentObservation );
  const currentObservation = observationProp ?? currentObservationFromStore;
  const lastLocationPickerState = useStore( state => state.lastLocationPickerState );
  const updateObservationKeys = useStore( state => state.updateObservationKeys );
  const setLastLocationPickerState = useStore( state => state.setLastLocationPickerState );
  const navigation = useNavigation( );

  const [state, dispatch] = useReducer( reducer, initialState );
  const [radiusToMapHeight, setRadiusToMapHeight] = useState<number | null>( null );
  const [mapDimensionsRatio, setMapDimensionsRatio] = useState<number | null>( null );

  const {
    accuracy,
    hidePlaceResults,
    isFirstMapRender,
    loading,
    locationName,
    region,
    regionToAnimate,
  } = state;

  const initialRegion = regionForObservationLocation(
    currentObservation,
    radiusToMapHeight,
    mapDimensionsRatio,
  ) || lastLocationPickerState?.region;

  const initializeMapFromObservation = useCallback( ( ) => {
    if ( !radiusToMapHeight || !mapDimensionsRatio ) {
      return;
    }
    dispatch( {
      type: "INITIALIZE_MAP",
      currentObservation,
      lastLocationPickerState,
      radiusToMapHeight,
      mapDimensionsRatio,
    } );
  }, [
    currentObservation,
    lastLocationPickerState,
    radiusToMapHeight,
    mapDimensionsRatio,
  ] );

  const onRegionChangeComplete = useCallback( async ( newRegion: Region ) => {
    // prevent initial map render from resetting the coordinates and locationName
    if ( isFirstMapRender ) {
      dispatch( { type: "HANDLE_FIRST_MAP_RENDER" } );
      return;
    }
    // We need this ratio to calculate accuracy
    if ( radiusToMapHeight === null ) {
      return;
    }
    // We calculate accuracy in meters as the distance represented by the radius of the crosshair
    // circle on top of the map. The circle has a fixed size in pixels the map height can vary
    // by device. We convert to meters based on the current map zoom level (latitudeDelta) and
    // the ratio of the crosshair radius to the map height.
    const newAccuracy = radiusToMapHeight
      * latitudeDeltaToMeters( newRegion.latitudeDelta, newRegion.latitude );

    const placeName = await fetchPlaceName( newRegion.latitude, newRegion.longitude );
    dispatch( {
      type: "HANDLE_REGION_CHANGE",
      locationName: placeName || "",
      region: newRegion,
      accuracy: newAccuracy,
    } );
  }, [isFirstMapRender, radiusToMapHeight] );

  const updateLocationName = useCallback( ( name: string ) => {
    dispatch( { type: "UPDATE_LOCATION_NAME", locationName: name } );
  }, [] );

  useEffect(
    ( ) => initializeMapFromObservation( ),
    [initializeMapFromObservation],
  );

  useEffect(
    ( ) => {
      const unsubscribe = navigation.addListener( "focus", initializeMapFromObservation );
      return unsubscribe;
    },
    [navigation, initializeMapFromObservation],
  );

  const selectPlaceResult = useCallback( ( place: LocationPickerPlace ) => {
    const { coordinates } = place.point_geojson;
    const latitude = coordinates[1];
    const longitude = coordinates[0];
    const bounds = boundingBoxGeojsonToBounds( place.bounding_box_geojson );

    if ( !bounds ) {
      dispatch( {
        type: "SELECT_PLACE_RESULT",
        locationName: place.display_name,
        region: {
          ...region,
          latitude,
          longitude,
        },
        regionToAnimate: {
          ...region,
          latitude,
          longitude,
        },
      } );
      return;
    }

    const placeAccuracy = accuracyToEncompassBounds( latitude, longitude, bounds );
    let newRegion;

    if ( radiusToMapHeight !== undefined && mapDimensionsRatio !== undefined ) {
      newRegion = regionForAccuracy(
        latitude,
        longitude,
        placeAccuracy,
        radiusToMapHeight,
        mapDimensionsRatio,
      );
    } else {
      newRegion = {
        ...getMapRegion( bounds ),
        latitude,
        longitude,
      };
    }

    dispatch( {
      type: "SELECT_PLACE_RESULT",
      locationName: place.display_name,
      region: newRegion,
      regionToAnimate: newRegion,
      accuracy: placeAccuracy,
    } );
  }, [region, radiusToMapHeight, mapDimensionsRatio] );

  const onCurrentLocationPress = ( ) => dispatch( { type: "HANDLE_CURRENT_LOCATION_PRESS" } );
  const onMapReady = useCallback( ( ) => dispatch( { type: "HANDLE_MAP_READY" } ), [] );

  const handleSave = ( ) => {
    if ( region && hasValidMapCoordinates( region.latitude, region.longitude ) ) {
      if ( onSave ) {
        // Caller owns persistence and navigation in this mode.
        onSave( {
          latitude: region.latitude,
          longitude: region.longitude,
          positional_accuracy: accuracy,
          place_guess: locationName,
        } );
        return;
      }
      const keysToUpdate = {
        latitude: region.latitude,
        longitude: region.longitude,
        positional_accuracy: accuracy,
        place_guess: locationName,
      };
      updateObservationKeys( keysToUpdate );
      setLastLocationPickerState( {
        region,
        accuracy,
        locationName,
      } );
    }
    navigation.goBack( );
  };

  const onMapLayout = ( event: LayoutChangeEvent ) => {
    const { height, width } = event.nativeEvent.layout;
    setRadiusToMapHeight( CROSSHAIRRADIUS / height );
    setMapDimensionsRatio( width / height );
  };

  return (
    <LocationPicker
      accuracy={accuracy}
      handleSave={handleSave}
      hidePlaceResults={hidePlaceResults}
      loading={loading}
      locationName={locationName}
      initialRegion={initialRegion}
      onCurrentLocationPress={onCurrentLocationPress}
      onMapReady={onMapReady}
      onRegionChangeComplete={onRegionChangeComplete}
      region={region}
      regionToAnimate={regionToAnimate}
      selectPlaceResult={selectPlaceResult}
      updateLocationName={updateLocationName}
      onMapLayout={onMapLayout}
      mapChildren={mapChildren}
      legend={legend}
    />
  );
};

export default LocationPickerContainer;
