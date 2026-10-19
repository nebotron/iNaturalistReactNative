import Config from "react-native-config";

const EBIRD_API_URL = "https://api.ebird.org/v2";

// eBird's own caps on geo searches
export const EBIRD_MAX_DIST_KM = 50;
export const EBIRD_BACK_DAYS = 30;
// Our caps, to keep traffic to eBird low
export const EBIRD_MAX_RESULTS = 100;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;

export const AVES_ID = 3;
// eBird results can't be filtered by these, so skip eBird rather than show
// results that ignore them
export const EBIRD_EXCLUSIVE_PARAMS = ["user_id", "project_id", "ident_user_id"];

export interface EbirdObservation {
  comName: string;
  howMany?: number;
  lat: number;
  lng: number;
  locName: string;
  obsDt: string;
  sciName: string;
  speciesCode: string;
  subId: string;
}

export class EbirdRateLimitError extends Error {}

export const isEbirdEnabled = ( ) => !!Config.EBIRD_API_KEY;

const requestTimes: number[] = [];

export const resetEbirdRateLimit = ( ) => { requestTimes.length = 0; };

const ebirdFetch = async ( path: string ): Promise<Response> => {
  const now = Date.now( );
  while ( requestTimes.length > 0 && now - requestTimes[0] > RATE_LIMIT_WINDOW_MS ) {
    requestTimes.shift( );
  }
  if ( requestTimes.length >= RATE_LIMIT_MAX_REQUESTS ) throw new EbirdRateLimitError( );
  requestTimes.push( now );
  const response = await fetch( `${EBIRD_API_URL}/${path}`, {
    headers: { "X-eBirdApiToken": Config.EBIRD_API_KEY || "" },
  } );
  if ( response.status === 429 ) throw new EbirdRateLimitError( );
  if ( !response.ok ) throw new Error( `eBird API error ${response.status}` );
  return response;
};

// Scientific name in the first column, species code in the third; common
// names may be quoted and contain commas
const TAXONOMY_ROW = /^([^,]+),(?:"[^"]*"|[^,]*),([^,]+),/;

let speciesCodesPromise: Promise<Map<string, string>> | null = null;

// eBird has no lookup by scientific name, so download the species list
// (~1.5 MB) once per app session
const fetchSpeciesCodes = ( ) => {
  speciesCodesPromise ||= ebirdFetch( "ref/taxonomy/ebird?fmt=csv&cat=species" )
    .then( response => response.text( ) )
    .then( csv => new Map( csv.split( "\n" ).flatMap( line => {
      const match = line.match( TAXONOMY_ROW );
      return match
        ? [[match[1], match[2]] as [string, string]]
        : [];
    } ) ) )
    .catch( e => {
      speciesCodesPromise = null;
      throw e;
    } );
  return speciesCodesPromise;
};

// Most recent sighting at each location (or of each species, without
// sciName) within distKm of a point
export const fetchEbirdObservations = async ( {
  sciName, lat, lng, distKm,
}: {
  sciName?: string;
  lat: number;
  lng: number;
  distKm: number;
} ): Promise<EbirdObservation[]> => {
  let path = "data/obs/geo/recent";
  if ( sciName ) {
    const speciesCode = ( await fetchSpeciesCodes( ) ).get( sciName );
    if ( !speciesCode ) return [];
    path += `/${speciesCode}`;
  }
  const dist = Math.min( Math.ceil( distKm ), EBIRD_MAX_DIST_KM );
  const response = await ebirdFetch(
    `${path}?lat=${lat}&lng=${lng}&dist=${dist}`
    + `&back=${EBIRD_BACK_DAYS}&maxResults=${EBIRD_MAX_RESULTS}`,
  );
  return response.json( );
};
