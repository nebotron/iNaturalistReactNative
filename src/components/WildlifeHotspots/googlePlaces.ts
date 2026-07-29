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

// Places API (New). The legacy Places endpoints can no longer be enabled in
// Cloud projects created after March 2025, so they aren't worth calling.
const PLACES_BASE = "https://places.googleapis.com/v1";
const AUTOCOMPLETE_FIELD_MASK = "suggestions.placePrediction.placeId,"
  + "suggestions.placePrediction.text.text";
// Soft location bias for results near the previous stop / current location.
// The API rejects a circle radius over 50km.
const BIAS_RADIUS_METERS = 50_000;
const MAX_SUGGESTIONS = 3;

// A key restricted to "iOS apps" only authorizes requests carrying this header
// with the app's bundle ID (unlike the native Maps SDK, a plain fetch doesn't
// attach it automatically), so it can't just reuse the Android-only
// GMAPS_API_KEY used for the native Maps SDK in AndroidManifest.xml.
const IOS_BUNDLE_ID_HEADER = "X-Ios-Bundle-Identifier";

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

export async function searchGooglePlaces(
  text: string,
  nearbyLatLng?: LatLng,
): Promise<PlaceResult[]> {
  const key = apiKey( );
  if ( !key ) {
    logger.error( "Places search skipped: no GMAPS_IOS_API_KEY or GMAPS_API_KEY in this build" );
    return [];
  }
  try {
    const response = await fetch( `${PLACES_BASE}/places:autocomplete`, {
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
                radius: BIAS_RADIUS_METERS,
              },
            },
          }
          : {} ),
      } ),
    } );
    if ( !response.ok ) {
      const detail = await errorDetail( response );
      logger.error( `Places autocomplete failed: HTTP ${response.status} ${detail}` );
      return [];
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
    logger.error( "Places autocomplete threw", error );
    return [];
  }
}

export async function fetchPlaceLatLng( placeId: string ): Promise<LatLng | null> {
  const key = apiKey( );
  if ( !key ) return null;
  try {
    const response = await fetch( `${PLACES_BASE}/places/${encodeURIComponent( placeId )}`, {
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "location",
        [IOS_BUNDLE_ID_HEADER]: DeviceInfo.getBundleId( ),
      },
    } );
    if ( !response.ok ) {
      const detail = await errorDetail( response );
      logger.error( `Place details failed: HTTP ${response.status} ${detail}` );
      return null;
    }
    const json = await response.json( );
    const location = json?.location;
    if ( typeof location?.latitude !== "number" ) {
      logger.error( "Place details returned no location" );
      return null;
    }
    return { latitude: location.latitude, longitude: location.longitude };
  } catch ( error ) {
    logger.error( "Place details threw", error );
    return null;
  }
}
