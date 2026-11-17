import { cachedRequest } from "components/WildlifeHotspots/requestCache";
import { distanceInKm } from "sharedHelpers/geoDistance";

import type { RoutePoint } from "./hooks/useRouteHotspots";

// Keyless OpenStreetMap query service, matching the OSRM routing and
// OpenStreetMap geocoding this view already uses
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
// Parking is looked for within a hotspot's observations plus this margin...
const PARKING_MARGIN_KM = 1;
// ...but never farther than this from its center, so a sprawling hotspot
// isn't routed to a lot that serves somewhere else
const MAX_PARKING_DISTANCE_KM = 3;

export interface ParkingSearchArea {
  latitude: number;
  longitude: number;
  // Radius of the hotspot's observations
  radiusKm: number;
}

const searchRadiusKm = ( area: ParkingSearchArea ) => Math.min(
  MAX_PARKING_DISTANCE_KM,
  area.radiusKm + PARKING_MARGIN_KM,
);

// One query for every hotspot: parking lots open to the public (no access tag,
// or one that isn't private) within each hotspot's search radius. Coordinates
// are rounded to about 10 m so the same hotspots make the same request.
function overpassQuery( areas: ParkingSearchArea[] ) {
  const clauses = areas.map( area => {
    const radiusM = Math.round( searchRadiusKm( area ) * 1000 );
    return "nwr[\"amenity\"=\"parking\"][\"access\"!~\"^(private|no|customers|permit|delivery)$\"]"
      + `(around:${radiusM},${area.latitude.toFixed( 4 )},${area.longitude.toFixed( 4 )});`;
  } );
  return `[out:json][timeout:25];(${clauses.join( "" )});out center qt;`;
}

async function fetchParkingUncached( query: string ): Promise<RoutePoint[]> {
  const response = await fetch( OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent( query )}`,
  } );
  if ( !response.ok ) {
    throw new Error( `Parking search error: ${response.status}` );
  }
  const data = await response.json( );
  // Nodes carry lat/lon; ways and relations carry their center
  return ( data.elements ?? [] ).flatMap( ( element: {
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
  } ) => {
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    return typeof lat === "number" && typeof lon === "number"
      ? [{ latitude: lat, longitude: lon }]
      : [];
  } );
}

// The parking nearest each area's center within its search radius, or null
// where there's none mapped
export async function findNearestParking(
  areas: ParkingSearchArea[],
): Promise<( RoutePoint | null )[]> {
  if ( areas.length === 0 ) return [];
  const query = overpassQuery( areas );
  const lots = await cachedRequest(
    "parking",
    30,
    query,
    ( ) => fetchParkingUncached( query ),
  );
  return areas.map( area => {
    let nearest: RoutePoint | null = null;
    let nearestKm = searchRadiusKm( area );
    lots.forEach( lot => {
      const km = distanceInKm( area.latitude, area.longitude, lot.latitude, lot.longitude );
      if ( km <= nearestKm ) {
        nearest = lot;
        nearestKm = km;
      }
    } );
    return nearest;
  } );
}
