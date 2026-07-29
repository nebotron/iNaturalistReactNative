import Config from "react-native-config";
import DeviceInfo from "react-native-device-info";
import type { LatLng } from "react-native-maps";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "googlePlaces" );

export interface PlaceResult {
  place_id: number | string;
  display_name: string;
  lat: string;
  lon: string;
}

const PLACES_NEW_BASE = "https://places.googleapis.com/v1";
const PLACES_LEGACY_BASE = "https://maps.googleapis.com/maps/api/place";
const AUTOCOMPLETE_FIELD_MASK = "suggestions.placePrediction.placeId,"
  + "suggestions.placePrediction.text.text";
// Soft location bias for autocomplete results near the previous stop / current
// location. Places API (New) rejects a circle radius over 50km, so its bias is
// tighter than the legacy endpoint's.
const BIAS_RADIUS_METERS = 200_000;
const NEW_BIAS_RADIUS_METERS = 50_000;
const MAX_SUGGESTIONS = 3;

// A key restricted to "iOS apps" only authorizes requests carrying this header
// with the app's bundle ID (unlike the native Maps SDK, a plain fetch doesn't
// attach it automatically), so it can't just reuse the Android-only
// GMAPS_API_KEY used for the native Maps SDK in AndroidManifest.xml.
const IOS_BUNDLE_ID_HEADER = "X-Ios-Bundle-Identifier";

// Places API (New) and Places API (Legacy) are separate products, enabled
// separately, and the legacy one can no longer be enabled at all in Cloud
// projects created after March 2025 — calling it there fails with
// REQUEST_DENIED, which is what silently emptied this dropdown. Rather than
// guess which one a given build's key can use, try both and remember whichever
// answered.
type PlacesApiFlavor = "new" | "legacy";
let workingFlavor: PlacesApiFlavor | null = null;

function apiKey( ): string | undefined {
  return Config.GMAPS_IOS_API_KEY || Config.GMAPS_API_KEY;
}

// Truncated so a failure never dumps a whole error page into the log.
async function errorDetail( response: Response ): Promise<string> {
  try {
    return ( await response.text( ) ).slice( 0, 300 );
  } catch {
    return "";
  }
}

// The request functions return null when the API itself failed (so the other
// flavor is worth trying) and an array when it answered, even with no matches.
async function autocompleteNew(
  text: string,
  key: string,
  nearbyLatLng?: LatLng,
): Promise<PlaceResult[] | null> {
  try {
    const response = await fetch( `${PLACES_NEW_BASE}/places:autocomplete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": AUTOCOMPLETE_FIELD_MASK,
        [IOS_BUNDLE_ID_HEADER]: DeviceInfo.getBundleId( ),
      },
      body: JSON.stringify( {
        input: text,
        languageCode: "en",
        ...( nearbyLatLng
          ? {
            locationBias: {
              circle: {
                center: {
                  latitude: nearbyLatLng.latitude,
                  longitude: nearbyLatLng.longitude,
                },
                radius: NEW_BIAS_RADIUS_METERS,
              },
            },
          }
          : {} ),
      } ),
    } );
    if ( !response.ok ) {
      const detail = await errorDetail( response );
      logger.error( `Places (new) autocomplete failed: HTTP ${response.status} ${detail}` );
      return null;
    }
    const json = await response.json( );
    return ( json.suggestions ?? [] )
      .filter( ( suggestion: { placePrediction?: unknown } ) => suggestion.placePrediction )
      .slice( 0, MAX_SUGGESTIONS )
      .map( ( suggestion: {
        placePrediction: { placeId: string; text?: { text?: string } };
      } ) => ( {
        place_id: suggestion.placePrediction.placeId,
        display_name: suggestion.placePrediction.text?.text ?? "",
        // Resolved lazily via fetchPlaceLatLng once the user picks a
        // suggestion; predictions carry no coordinates.
        lat: "",
        lon: "",
      } ) );
  } catch ( error ) {
    logger.error( "Places (new) autocomplete threw", error );
    return null;
  }
}

async function autocompleteLegacy(
  text: string,
  key: string,
  nearbyLatLng?: LatLng,
): Promise<PlaceResult[] | null> {
  try {
    let url = `${PLACES_LEGACY_BASE}/autocomplete/json`
      + `?input=${encodeURIComponent( text )}&language=en&key=${key}`;
    if ( nearbyLatLng ) {
      url += `&location=${nearbyLatLng.latitude},${nearbyLatLng.longitude}`
        + `&radius=${BIAS_RADIUS_METERS}`;
    }
    const response = await fetch( url, {
      headers: { [IOS_BUNDLE_ID_HEADER]: DeviceInfo.getBundleId( ) },
    } );
    if ( !response.ok ) {
      logger.error( `Places (legacy) autocomplete failed: HTTP ${response.status}` );
      return null;
    }
    const json = await response.json( );
    // ZERO_RESULTS means the API answered; anything else is a real failure.
    if ( json.status === "ZERO_RESULTS" ) return [];
    if ( json.status !== "OK" ) {
      logger.error(
        `Places (legacy) autocomplete failed: ${json.status} ${json.error_message ?? ""}`,
      );
      return null;
    }
    return json.predictions.slice( 0, MAX_SUGGESTIONS ).map( ( prediction: {
      place_id: string;
      description: string;
    } ) => ( {
      place_id: prediction.place_id,
      display_name: prediction.description,
      lat: "",
      lon: "",
    } ) );
  } catch ( error ) {
    logger.error( "Places (legacy) autocomplete threw", error );
    return null;
  }
}

async function placeLatLngNew( placeId: string, key: string ): Promise<LatLng | null> {
  try {
    const response = await fetch( `${PLACES_NEW_BASE}/places/${encodeURIComponent( placeId )}`, {
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "location",
        [IOS_BUNDLE_ID_HEADER]: DeviceInfo.getBundleId( ),
      },
    } );
    if ( !response.ok ) {
      logger.error(
        `Place (new) details failed: HTTP ${response.status} ${await errorDetail( response )}`,
      );
      return null;
    }
    const json = await response.json( );
    const location = json?.location;
    if ( typeof location?.latitude !== "number" ) return null;
    return { latitude: location.latitude, longitude: location.longitude };
  } catch ( error ) {
    logger.error( "Place (new) details threw", error );
    return null;
  }
}

async function placeLatLngLegacy( placeId: string, key: string ): Promise<LatLng | null> {
  try {
    const url = `${PLACES_LEGACY_BASE}/details/json`
      + `?place_id=${encodeURIComponent( placeId )}&fields=geometry&key=${key}`;
    const response = await fetch( url, {
      headers: { [IOS_BUNDLE_ID_HEADER]: DeviceInfo.getBundleId( ) },
    } );
    if ( !response.ok ) {
      logger.error( `Place (legacy) details failed: HTTP ${response.status}` );
      return null;
    }
    const json = await response.json( );
    const location = json?.result?.geometry?.location;
    if ( !location ) {
      logger.error( `Place (legacy) details failed: ${json?.status} ${json?.error_message ?? ""}` );
      return null;
    }
    return { latitude: location.lat, longitude: location.lng };
  } catch ( error ) {
    logger.error( "Place (legacy) details threw", error );
    return null;
  }
}

// Runs the flavor that answered last (new first, until proven otherwise) and
// falls back to the other one, remembering whichever worked.
async function withFlavorFallback<T>(
  runNew: ( ) => Promise<T | null>,
  runLegacy: ( ) => Promise<T | null>,
): Promise<T | null> {
  const preferNew = workingFlavor !== "legacy";
  const preferred = await ( preferNew
    ? runNew( )
    : runLegacy( ) );
  if ( preferred !== null ) {
    workingFlavor = preferNew
      ? "new"
      : "legacy";
    return preferred;
  }
  const fallback = await ( preferNew
    ? runLegacy( )
    : runNew( ) );
  if ( fallback !== null ) {
    workingFlavor = preferNew
      ? "legacy"
      : "new";
  }
  return fallback;
}

export async function searchGooglePlaces(
  text: string,
  nearbyLatLng?: LatLng,
): Promise<PlaceResult[]> {
  const key = apiKey( );
  if ( !key ) {
    logger.error( "Places search skipped: no GMAPS_IOS_API_KEY or GMAPS_API_KEY in this build" );
    return [];
  }
  const results = await withFlavorFallback(
    ( ) => autocompleteNew( text, key, nearbyLatLng ),
    ( ) => autocompleteLegacy( text, key, nearbyLatLng ),
  );
  return results ?? [];
}

export async function fetchPlaceLatLng( placeId: string ): Promise<LatLng | null> {
  const key = apiKey( );
  if ( !key ) return null;
  return withFlavorFallback(
    ( ) => placeLatLngNew( placeId, key ),
    ( ) => placeLatLngLegacy( placeId, key ),
  );
}
