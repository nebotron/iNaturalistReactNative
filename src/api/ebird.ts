import { searchTaxa } from "api/taxa";
import type { ApiObservation } from "api/types";
import Config from "react-native-config";
import { MMKV } from "react-native-mmkv";
import { getTunable } from "sharedHelpers/tunableParams";

const EBIRD_API_URL = "https://api.ebird.org/v2";

// eBird's own caps on geo searches
export const EBIRD_MAX_DIST_KM = getTunable( "ebirdMaxDistKm" );
const EBIRD_BACK_DAYS = getTunable( "ebirdBackDays" );
// Our caps, to keep traffic to eBird low
export const EBIRD_MAX_RESULTS = getTunable( "ebirdMaxResults" );
// Fetched before filtering by taxon on the client. A search without a
// species returns one sighting per species, so this is rarely reached.
const EBIRD_MAX_FETCHED = 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TAXA_PER_PAGE = 500;
const MAX_TAXA_PAGES = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;

const AVES_ID = 3;
// eBird sightings can't match these, so skip eBird rather than show results
// that ignore them
export const EBIRD_EXCLUSIVE_PARAMS = [
  "user_id",
  "project_id",
  "ident_user_id",
  "photos",
  "sounds",
  "captive",
  "popular",
  "reviewed",
  "photo_license",
  "created_on",
  "created_d1",
  "created_d2",
];
// Narrow eBird sightings by observation date, as they do iNaturalist results
export const EBIRD_DATE_PARAMS = ["observed_on", "d1", "d2", "month", "year"];

interface EbirdObservation {
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

// An eBird sighting shaped like an iNaturalist API observation, so every view
// can show and group it like one
export interface EbirdInatObservation extends ApiObservation {
  ebirdChecklistUrl: string;
  place_guess: string;
}

export const ebirdToInatObservation = (
  obs: EbirdObservation,
  taxonId?: number,
): EbirdInatObservation => ( {
  uuid: `ebird-${obs.subId}-${obs.speciesCode}`,
  ebirdChecklistUrl: `https://ebird.org/checklist/${obs.subId}`,
  geojson: { coordinates: [obs.lng, obs.lat] },
  latitude: obs.lat,
  longitude: obs.lng,
  place_guess: obs.locName,
  observed_on: obs.obsDt.slice( 0, 10 ),
  // obsDt is "YYYY-MM-DD HH:mm", or just the date when no time was recorded
  time_observed_at: obs.obsDt.length > 10
    ? obs.obsDt.replace( " ", "T" )
    : undefined,
  quality_grade: "research",
  taxon: {
    id: taxonId,
    name: obs.sciName,
    preferred_common_name: obs.comName,
    rank: "species",
    rank_level: 10,
    iconic_taxon_name: "Aves",
  },
} );

export const isEbirdObservation = ( obs: object ): obs is EbirdInatObservation => (
  "ebirdChecklistUrl" in obs
);

const listOf = ( value: unknown ) => ( Array.isArray( value )
  ? value
  : String( value ?? "" ).split( "," ) ).map( String ).filter( Boolean );

// Whether a sighting on `date` (YYYY-MM-DD) matches a search's date filters
const matchesDates = ( params: Record<string, unknown>, date: string ) => {
  const { observed_on: on, d1, d2 } = params;
  if ( on && date !== on ) return false;
  if ( d1 && date < String( d1 ) ) return false;
  if ( d2 && date > String( d2 ) ) return false;
  const months = listOf( params.month ).map( Number );
  if ( months.length && !months.includes( Number( date.slice( 5, 7 ) ) ) ) return false;
  const years = listOf( params.year ).map( Number );
  return !years.length || years.includes( Number( date.slice( 0, 4 ) ) );
};

// Whether a search's date filters reach back further than eBird's window
export const datesExceedEbirdWindow = ( params: Record<string, unknown> ) => {
  if ( !EBIRD_DATE_PARAMS.some( key => params[key] ) ) return false;
  const cutoff = new Date( Date.now( ) - EBIRD_BACK_DAYS * 24 * 60 * 60 * 1000 )
    .toISOString( )
    .slice( 0, 10 );
  const start = params.observed_on || params.d1;
  return !start || String( start ) < cutoff;
};

export class EbirdRateLimitError extends Error {}

export const isEbirdEnabled = ( ) => !!Config.EBIRD_API_KEY;

const requestTimes: number[] = [];

export const resetEbirdRateLimit = ( ) => { requestTimes.length = 0; };

const cache = new MMKV( { id: "ebird-cache" } );

// Results of `fetcher`, kept on disk for up to a day
const cached = async <T>( key: string, fetcher: ( ) => Promise<T> ): Promise<T> => {
  const now = Date.now( );
  try {
    const entry = JSON.parse( cache.getString( key ) || "null" );
    if ( entry && now - entry.time < CACHE_TTL_MS ) return entry.data as T;
  } catch {
    // Unreadable; refetch
  }
  const data = await fetcher( );
  cache.getAllKeys( ).forEach( oldKey => {
    try {
      if ( now - JSON.parse( cache.getString( oldKey ) || "{}" ).time < CACHE_TTL_MS ) return;
    } catch {
      // Unreadable; delete
    }
    cache.delete( oldKey );
  } );
  cache.set( key, JSON.stringify( { time: now, data } ) );
  return data;
};

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

let speciesCodesPromise: Promise<Record<string, string>> | null = null;

// eBird has no lookup by scientific name, so download the species list
// (~1.5 MB) once a day
const fetchSpeciesCodes = ( ) => {
  speciesCodesPromise ||= cached( "taxonomy", async ( ) => {
    const response = await ebirdFetch( "ref/taxonomy/ebird?fmt=csv&cat=species" );
    const csv = await response.text( );
    return Object.fromEntries( csv.split( "\n" ).flatMap( line => {
      const match = line.match( TAXONOMY_ROW );
      return match
        ? [[match[1], match[2]]]
        : [];
    } ) );
  } ).catch( e => {
    speciesCodesPromise = null;
    throw e;
  } );
  return speciesCodesPromise;
};

// Which birds a search's taxon filters allow, by scientific name: species
// ("Turdus migratorius") and genera ("Turdus")
export interface EbirdTaxonFilter {
  // A single species, which eBird can search for directly
  sciName?: string;
  // Undefined allows all birds
  include?: string[];
  exclude: string[];
}

const inNames = ( names: string[], sciName: string ) => {
  const [genus, epithet] = sciName.split( " " );
  return names.includes( genus ) || names.includes( `${genus} ${epithet}` );
};

const matchesEbirdTaxonFilter = ( filter: EbirdTaxonFilter, sciName: string ) => (
  !filter.include || inNames( filter.include, sciName )
) && !inNames( filter.exclude, sciName );

interface FilterTaxon { id: number; name: string; rank_level: number; ancestor_ids: number[] }

const TAXON_FIELDS = {
  id: true, name: true, rank_level: true, ancestor_ids: true,
};

const descendantNames = ( taxonId: number, rank: string ) => cached(
  `descendants:${taxonId}:${rank}`,
  async ( ) => {
    const names: string[] = [];
    for ( let page = 1; page <= MAX_TAXA_PAGES; page += 1 ) {
      // eslint-disable-next-line no-await-in-loop
      const results: FilterTaxon[] = await searchTaxa( {
        taxon_id: taxonId,
        rank,
        is_active: true,
        per_page: TAXA_PER_PAGE,
        page,
        fields: TAXON_FIELDS,
      } ) || [];
      names.push( ...results.map( taxon => taxon.name ) );
      if ( results.length < TAXA_PER_PAGE ) break;
    }
    return names;
  },
);

// Names an eBird sighting can match for a taxon within birds
const birdTaxonNames = async ( taxon: FilterTaxon ): Promise<string[]> => {
  if ( taxon.rank_level <= 10 ) return [taxon.name.split( " " ).slice( 0, 2 ).join( " " )];
  if ( taxon.rank_level === 20 ) return [taxon.name];
  return descendantNames( taxon.id, taxon.rank_level < 20
    ? "species"
    : "genus" );
};

const idList = ( value: unknown ) => String( value ?? "" )
  .split( "," )
  .map( Number )
  .filter( Boolean );

// The birds a search's filters allow, or null when they allow none or can't
// apply to eBird
export const resolveEbirdTaxonFilter = async (
  params: Record<string, unknown>,
): Promise<EbirdTaxonFilter | null> => {
  if ( EBIRD_EXCLUSIVE_PARAMS.some( key => params[key] ) ) return null;
  // eBird sightings are treated as research grade
  const qualityGrades = listOf( params.quality_grade );
  if ( qualityGrades.length && !qualityGrades.includes( "research" ) ) return null;
  const includeIds = idList( params.taxon_id );
  const excludeIds = idList( params.without_taxon_id );
  const iconicTaxa = params.iconic_taxa as string[] | undefined;
  if ( !includeIds.length && iconicTaxa?.length && !iconicTaxa.includes( "Aves" ) ) return null;
  if ( !includeIds.length && !excludeIds.length ) return { exclude: [] };

  // A My Lifers search can exclude hundreds of species, more than one page.
  // Without per_page the API returns only the first 30, dropping exclusions
  // and possibly Aves itself.
  const ids = [...new Set( [AVES_ID, ...includeIds, ...excludeIds] )];
  const chunks: number[][] = [];
  for ( let i = 0; i < ids.length; i += TAXA_PER_PAGE ) {
    chunks.push( ids.slice( i, i + TAXA_PER_PAGE ) );
  }
  const taxa: FilterTaxon[] = ( await Promise.all( chunks.map( async chunk => (
    await searchTaxa( {
      id: chunk.join( "," ),
      per_page: TAXA_PER_PAGE,
      fields: TAXON_FIELDS,
    } ) || []
  ) ) ) ).flat( );
  const aves = taxa.find( taxon => taxon.id === AVES_ID );
  const containsBirds = ( id: number ) => id === AVES_ID || !!aves?.ancestor_ids.includes( id );
  const birdTaxa = ( ids: number[] ) => taxa.filter(
    taxon => ids.includes( taxon.id ) && taxon.ancestor_ids.includes( AVES_ID ),
  );
  const namesOf = async ( ids: number[] ) => (
    await Promise.all( birdTaxa( ids ).map( birdTaxonNames ) )
  ).flat( );

  if ( excludeIds.some( containsBirds ) ) return null;
  const exclude = await namesOf( excludeIds );
  if ( !includeIds.length || includeIds.some( containsBirds ) ) return { exclude };
  const included = birdTaxa( includeIds );
  if ( !included.length ) return null;
  const include = await namesOf( includeIds );
  const sciName = included.length === 1 && included[0].rank_level <= 10 && !exclude.length
    ? include[0]
    : undefined;
  return { sciName, include, exclude };
};

// Most recent sighting at each location (with a single species) or of each
// species within distKm of a point, matching the taxon and date filters
export const fetchEbirdObservations = async ( {
  taxonFilter, dateParams = {}, lat, lng, distKm,
}: {
  taxonFilter: EbirdTaxonFilter;
  dateParams?: Record<string, unknown>;
  lat: number;
  lng: number;
  distKm: number;
} ): Promise<EbirdObservation[]> => {
  const { sciName } = taxonFilter;
  let path = "data/obs/geo/recent";
  if ( sciName ) {
    const speciesCode = ( await fetchSpeciesCodes( ) )[sciName];
    if ( !speciesCode ) return [];
    path += `/${speciesCode}`;
  }
  const dist = Math.min( Math.ceil( distKm ), EBIRD_MAX_DIST_KM );
  const maxResults = sciName
    ? EBIRD_MAX_RESULTS
    : EBIRD_MAX_FETCHED;
  path += `?lat=${lat}&lng=${lng}&dist=${dist}&back=${EBIRD_BACK_DAYS}&maxResults=${maxResults}`;
  const observations: EbirdObservation[] = await cached(
    path,
    async ( ) => ( await ebirdFetch( path ) ).json( ),
  );
  return observations
    .filter( obs => matchesEbirdTaxonFilter( taxonFilter, obs.sciName )
      && matchesDates( dateParams, obs.obsDt.slice( 0, 10 ) ) )
    .slice( 0, EBIRD_MAX_RESULTS );
};
