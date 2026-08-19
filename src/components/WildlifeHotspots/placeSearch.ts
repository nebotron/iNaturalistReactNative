import { getUserAgent } from "api/userAgent";
import type { LatLng } from "react-native-maps";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "placeSearch" );

export interface PlaceResult {
  place_id: number | string;
  display_name: string;
  lat: string;
  lon: string;
}

// Keyless OpenStreetMap geocoders, matching the OSRM routing this screen
// already uses. Google's Places API needs a Cloud project with billing and
// Places API (New) enabled, plus a key whose API restrictions allow it; when
// either is missing every keystroke 403s and the dropdown stays empty, which
// is exactly how this search broke. Photon is built for type-ahead and returns
// coordinates with each suggestion (so picking one needs no second request);
// Nominatim covers the queries Photon comes up empty on.
const PHOTON_URL = "https://photon.komoot.io/api";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const MAX_SUGGESTIONS = 5;
// Photon expresses its location bias as a map zoom level rather than a
// distance. Measured against the live API (median distance of the top results
// from the bias point), zoom 10 keeps results within ~27 miles and zoom 8
// spreads to ~125; zoom 9 lands at ~90, the closest step to the ~100 mile
// radius we want around the previous stop. Anything tighter ranks a nearby
// residential street above a national park two hours up the road.
const PHOTON_ZOOM = 9;
// Nominatim biases with a box instead. ~1.5 degrees of latitude is the same
// ~100 mile radius.
const BIAS_DEGREES = 1.5;

// Suggestions are cached by query so backspacing, retyping, or refocusing a
// field doesn't refetch. The bias point is part of the key because the same
// text ranks differently from a different stop.
const CACHE_LIMIT = 50;
const cache = new Map<string, PlaceResult[]>( );

function cacheKey( text: string, nearbyLatLng?: LatLng ): string {
  const bias = nearbyLatLng
    ? `${nearbyLatLng.latitude.toFixed( 2 )},${nearbyLatLng.longitude.toFixed( 2 )}`
    : "";
  return `${text.trim( ).toLowerCase( )}|${bias}`;
}

// Only successful lookups are cached, so a network blip doesn't pin an empty
// dropdown to a query for the rest of the session.
function remember( key: string, results: PlaceResult[] ): PlaceResult[] {
  if ( results.length > 0 ) {
    cache.set( key, results );
    if ( cache.size > CACHE_LIMIT ) {
      const oldest = cache.keys( ).next( ).value;
      if ( oldest !== undefined ) cache.delete( oldest );
    }
  }
  return results;
}

interface PhotonProperties {
  osm_id?: number;
  osm_type?: string;
  name?: string;
  housenumber?: string;
  street?: string;
  city?: string;
  state?: string;
  country?: string;
}

interface PhotonFeature {
  properties?: PhotonProperties;
  geometry?: { coordinates?: number[] };
}

// Photon returns address components rather than a formatted line, so build one
// that reads like Nominatim's display_name.
function photonDisplayName( properties: PhotonProperties = {} ): string {
  const street = [properties.housenumber, properties.street]
    .filter( Boolean )
    .join( " " );
  return [
    properties.name,
    street,
    properties.city,
    properties.state,
    properties.country,
  ].filter( Boolean ).join( ", " );
}

async function searchPhoton( text: string, nearbyLatLng?: LatLng ): Promise<PlaceResult[]> {
  const bias = nearbyLatLng
    ? `&lat=${nearbyLatLng.latitude}&lon=${nearbyLatLng.longitude}&zoom=${PHOTON_ZOOM}`
    : "";
  // Over-fetch because Photon often returns the same place as separate OSM
  // node/way features, which would otherwise fill the dropdown with duplicates.
  const url = `${PHOTON_URL}?q=${encodeURIComponent( text )}`
    + `&limit=${MAX_SUGGESTIONS * 3}&lang=en${bias}`;
  const response = await fetch( url );
  if ( !response.ok ) {
    logger.error( `Photon search failed: HTTP ${response.status}` );
    return [];
  }
  const json = await response.json( );
  const seen = new Set<string>( );
  return ( json?.features ?? [] )
    .filter( ( feature: PhotonFeature ) => feature.geometry?.coordinates?.length === 2 )
    .map( ( feature: PhotonFeature, index: number ) => {
      const [lon, lat] = feature.geometry?.coordinates as number[];
      return {
        place_id: `photon-${feature.properties?.osm_type ?? ""}${
          feature.properties?.osm_id ?? index}`,
        display_name: photonDisplayName( feature.properties ),
        lat: String( lat ),
        lon: String( lon ),
      };
    } )
    .filter( ( result: PlaceResult ) => {
      if ( result.display_name.length === 0 || seen.has( result.display_name ) ) return false;
      seen.add( result.display_name );
      return true;
    } )
    .slice( 0, MAX_SUGGESTIONS );
}

async function searchNominatim( text: string, nearbyLatLng?: LatLng ): Promise<PlaceResult[]> {
  const bias = nearbyLatLng
    ? `&viewbox=${[
      nearbyLatLng.longitude - BIAS_DEGREES,
      nearbyLatLng.latitude + BIAS_DEGREES,
      nearbyLatLng.longitude + BIAS_DEGREES,
      nearbyLatLng.latitude - BIAS_DEGREES,
    ].join( "," )}`
    : "";
  const url
    = `${NOMINATIM_URL}?q=${encodeURIComponent( text )}&format=json`
      + `&limit=${MAX_SUGGESTIONS}${bias}`;
  // Nominatim's usage policy requires an identifiable user agent.
  const response = await fetch( url, { headers: { "User-Agent": getUserAgent( ) } } );
  if ( !response.ok ) {
    logger.error( `Nominatim search failed: HTTP ${response.status}` );
    return [];
  }
  const json = await response.json( );
  return ( json ?? [] ).map( ( result: PlaceResult ) => ( {
    place_id: result.place_id,
    display_name: result.display_name,
    lat: result.lat,
    lon: result.lon,
  } ) );
}

// Suggestions carry their own coordinates, so selecting one needs no follow-up
// place details lookup.
export async function searchPlaces(
  text: string,
  nearbyLatLng?: LatLng,
): Promise<PlaceResult[]> {
  const key = cacheKey( text, nearbyLatLng );
  const cached = cache.get( key );
  if ( cached ) return cached;
  try {
    const photonResults = await searchPhoton( text, nearbyLatLng );
    if ( photonResults.length > 0 ) return remember( key, photonResults );
  } catch ( error ) {
    logger.error( "Photon search threw", error );
  }
  try {
    return remember( key, await searchNominatim( text, nearbyLatLng ) );
  } catch ( error ) {
    logger.error( "Nominatim search threw", error );
    return [];
  }
}

export default searchPlaces;
