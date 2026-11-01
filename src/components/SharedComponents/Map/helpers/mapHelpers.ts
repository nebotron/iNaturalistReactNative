import type { MapBoundaries } from "providers/ExploreContext";
import type { BoundingBox, LatLng, Region } from "react-native-maps";
import createUTFPosition from "sharedHelpers/createUTFPosition";
import { EnvConfig } from "sharedHelpers/envConfig";
import getDataForPixel from "sharedHelpers/fetchUTFGridData";
import distanceInMeters from "sharedHelpers/geoDistance";
import { getTunable } from "sharedHelpers/tunableParams";

export const OBSCURATION_CELL_SIZE = 0.2;
const API_URL = EnvConfig.API_URL || process.env.API_URL || "https://api.inaturalist.org/v2";

function getTileUrl( apiUrl: string ) {
  try {
    const parsedUrl = new URL( apiUrl );
    if ( parsedUrl.hostname === "api.inaturalist.org" ) {
      // tiles should be requested from tiles.inaturalist.org for better resource
      // balancing
      parsedUrl.hostname = "tiles.inaturalist.org";
      return parsedUrl.toString();
    }
    return apiUrl;
  } catch {
    return apiUrl;
  }
}
export const TILE_URL = getTileUrl( API_URL );
const POINT_TILES_ENDPOINT = `${TILE_URL}/points`;

// getMapBoundaries is one of the few MapView methods that round-trips to the
// native view and returns a promise, so it rejects ("Invalid view returned
// from registry, expecting RNMapsMapView, got: (null)") when the native view
// is torn down between the call and the response — e.g. onRegionChangeComplete
// firing while the screen is being unmounted. Nothing can be done about it and
// nobody needs boundaries for a map that no longer exists, so resolve to
// undefined rather than leaving an unhandled promise rejection behind.
export async function getMapBoundariesSafely(
  mapView: { getMapBoundaries: ( ) => Promise<BoundingBox> } | null | undefined,
): Promise<BoundingBox | undefined> {
  return mapView
    ?.getMapBoundaries( )
    .catch( ( ) => undefined );
}

export function calculateZoom( width: number, delta: number ) {
  return Math.log2( 360 * ( width / 256 / delta ) ) + 1;
}

// Kind of the inverse of calculateZoom. Probably not actually accurate for
// longitude, but works for our purposes
export function zoomToDeltas( zoom: number, screenWidth: number, screenHeight: number ) {
  const longitudeDelta = screenWidth / 256 / ( 2 ** zoom / 360 );
  const latitudeDelta = screenHeight / 256 / ( 2 ** zoom / 360 );
  return [latitudeDelta, longitudeDelta];
}

// Adapted from
// https://github.com/inaturalist/inaturalist/blob/main/app/assets/javascripts/inaturalist/map3.js.erb#L1500
export function obscurationCellForLatLng( lat: number, lng: number ) {
  const coords = [lat, lng];
  const firstCorner = [
    coords[0] - ( coords[0] % OBSCURATION_CELL_SIZE ),
    coords[1] - ( coords[1] % OBSCURATION_CELL_SIZE ),
  ];
  const secondCorner = [firstCorner[0], firstCorner[1]];
  coords.forEach( ( value, index ) => {
    if ( value < secondCorner[index] ) {
      secondCorner[index] -= OBSCURATION_CELL_SIZE;
    } else {
      secondCorner[index] += OBSCURATION_CELL_SIZE;
    }
  } );
  return {
    minLat: Math.min( firstCorner[0], secondCorner[0] ),
    minLng: Math.min( firstCorner[1], secondCorner[1] ),
    maxLat: Math.max( firstCorner[0], secondCorner[0] ),
    maxLng: Math.max( firstCorner[1], secondCorner[1] ),
  };
}

function metersPerDegreeLatitude( latitude: number ): number {
  const phi = ( latitude * Math.PI ) / 180;

  return (
    111132.92
    - 559.82 * Math.cos( 2 * phi )
    + 1.175 * Math.cos( 4 * phi )
    - 0.0023 * Math.cos( 6 * phi )
  );
}

export function metersToLatitudeDelta(
  meters: number,
  latitude: number,
): number {
  return meters / metersPerDegreeLatitude( latitude );
}

export function latitudeDeltaToMeters(
  latitudeDelta: number,
  latitude: number,
): number {
  return latitudeDelta * metersPerDegreeLatitude( latitude );
}

// Width in degrees of a bounding box, measured eastward from swlng to nelng.
// A box crossing the antimeridian is encoded swlng > nelng
export function longitudeSpan( swlng: number, nelng: number ): number {
  const span = Number( nelng ) - Number( swlng );
  return span < 0
    ? span + 360
    : span;
}

export interface GeoJsonPolygon {
  coordinates: number[][][];
}

export function boundingBoxGeojsonToBounds(
  bbox?: GeoJsonPolygon | null,
): MapBoundaries | null {
  const ring = bbox?.coordinates?.[0];
  if ( !ring?.length ) {
    return null;
  }

  const lngs = ring.map( coordinate => coordinate[0] );
  const lats = ring.map( coordinate => coordinate[1] );

  return {
    swlat: Math.min( ...lats ),
    swlng: Math.min( ...lngs ),
    nelat: Math.max( ...lats ),
    nelng: Math.max( ...lngs ),
  };
}

export function accuracyToEncompassBounds(
  centerLat: number,
  centerLng: number,
  bounds: MapBoundaries,
): number {
  const corners: [number, number][] = [
    [bounds.swlat, bounds.swlng],
    [bounds.swlat, bounds.nelng],
    [bounds.nelat, bounds.swlng],
    [bounds.nelat, bounds.nelng],
  ];

  return Math.max(
    ...corners.map( ( [lat, lng] ) => distanceInMeters(
      centerLat,
      centerLng,
      lat,
      lng,
    ) ),
  );
}

export const DEFAULT_OBSERVATION_LOCATION_ACCURACY_METERS = getTunable(
  "defaultObsLocationAccuracyM",
);

export function hasValidMapCoordinates(
  latitude?: number | null,
  longitude?: number | null,
): boolean {
  if ( latitude == null || longitude == null ) {
    return false;
  }
  if ( Number.isNaN( latitude ) || Number.isNaN( longitude ) ) {
    return false;
  }
  if ( latitude === 0 && longitude === 0 ) {
    return false;
  }
  return latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180;
}

interface ObservationWithCoordinates {
  privateLatitude?: number | null;
  latitude?: number | null;
  privateLongitude?: number | null;
  longitude?: number | null;
  positional_accuracy?: number | null;
}

export function getObservationCoordinates(
  observation?: ObservationWithCoordinates | null,
): { latitude: number; longitude: number } | null {
  const latitude = observation?.privateLatitude ?? observation?.latitude;
  const longitude = observation?.privateLongitude ?? observation?.longitude;

  if ( !hasValidMapCoordinates( latitude, longitude ) ) {
    return null;
  }

  return {
    latitude: latitude as number,
    longitude: longitude as number,
  };
}

export function regionForAccuracy(
  latitude: number,
  longitude: number,
  accuracyMeters: number,
  radiusToMapHeight: number,
  mapDimensionsRatio: number,
): Region {
  const latitudeDelta = metersToLatitudeDelta(
    accuracyMeters,
    latitude,
  ) / radiusToMapHeight;

  return {
    latitude,
    longitude,
    latitudeDelta,
    longitudeDelta: latitudeDelta * mapDimensionsRatio,
  };
}

export function regionForObservationLocation(
  observation: ObservationWithCoordinates | null | undefined,
  radiusToMapHeight: number | undefined,
  mapDimensionsRatio: number | undefined,
): Region | null {
  if ( !radiusToMapHeight || !mapDimensionsRatio ) {
    return null;
  }

  const coordinates = getObservationCoordinates( observation );
  if ( !coordinates ) {
    return null;
  }

  const accuracyMeters = observation?.positional_accuracy
    ?? DEFAULT_OBSERVATION_LOCATION_ACCURACY_METERS;

  return regionForAccuracy(
    coordinates.latitude,
    coordinates.longitude,
    accuracyMeters,
    radiusToMapHeight,
    mapDimensionsRatio,
  );
}

export function regionFromBounds( bounds: MapBoundaries ): Region {
  const {
    nelat, nelng, swlat, swlng,
  } = bounds;
  const latitudeDelta = Math.abs( Number( nelat ) - Number( swlat ) );
  const longitudeDelta = longitudeSpan( swlng, nelng );
  const longitude = Number( swlng ) + ( longitudeDelta / 2 );

  return {
    latitude: Math.min( Number( swlat ), Number( nelat ) ) + ( latitudeDelta / 2 ),
    longitude: longitude > 180
      ? longitude - 360
      : longitude,
    latitudeDelta,
    longitudeDelta,
  };
}

export function getMapRegion( totalBounds: MapBoundaries ): Region {
  const { latitudeDelta, longitudeDelta, ...center } = regionFromBounds( totalBounds );

  return {
    ...center,
    latitudeDelta: Math.min( latitudeDelta + latitudeDelta * 0.4, 89 ),
    longitudeDelta: Math.min( longitudeDelta + longitudeDelta * 0.4, 179 ),
  };
}

export async function fetchObservationUUID(
  currentZoom: number,
  latLng: LatLng,
  params: Record<string, unknown>,
) {
  const UTFPosition = createUTFPosition( currentZoom, latLng.latitude, latLng.longitude );
  const {
    mTilePositionX,
    mTilePositionY,
    mPixelPositionX,
    mPixelPositionY,
  } = UTFPosition;
  const tilesParams: Record<string, unknown> = {
    ...params,
    style: "geotilegrid",
  };
  const gridQuery = Object.keys( tilesParams )
    .map( key => `${key}=${tilesParams[key]}` ).join( "&" );

  const gridUrl = `${POINT_TILES_ENDPOINT}/${currentZoom}/${mTilePositionX}/${mTilePositionY}`
    + ".grid.json";
  const gridUrlTemplate = `${gridUrl}?${gridQuery}`;

  const options = {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  };

  const response = await fetch( gridUrlTemplate, options );
  const json = await response.json( );

  const observation = getDataForPixel( mPixelPositionX, mPixelPositionY, json );
  const uuid = observation?.uuid;
  return uuid;
}
