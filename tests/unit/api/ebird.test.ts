import {
  EbirdRateLimitError,
  fetchEbirdObservations,
  resetEbirdRateLimit,
  resolveEbirdTaxonFilter,
} from "api/ebird";
import { searchTaxa } from "api/taxa";

jest.mock( "react-native-config", ( ) => ( { EBIRD_API_KEY: "test-key" } ) );
jest.mock( "api/taxa", ( ) => ( { searchTaxa: jest.fn( ) } ) );

const TAXONOMY_CSV = "SCIENTIFIC_NAME,COMMON_NAME,SPECIES_CODE,CATEGORY\n"
  + "Butorides virescens,Green Heron,grnher,species\n"
  + "Some bird,\"Heron, Odd\",oddher,species\n";

const SIGHTINGS = [
  { subId: "S1", sciName: "Butorides virescens" },
  { subId: "S2", sciName: "Turdus migratorius" },
  { subId: "S3", sciName: "Turdus merula" },
];

const mockFetch = jest.fn( ( _url: string ) => Promise.resolve( {
  ok: true,
  status: 200,
  text: ( ) => Promise.resolve( TAXONOMY_CSV ),
  json: ( ) => Promise.resolve( SIGHTINGS ),
} ) );
global.fetch = mockFetch as unknown as typeof fetch;

// Each test uses its own location so the day-long cache doesn't answer it
let lat = 0;
const area = ( ) => {
  lat += 1;
  return { lat, lng: -122, distKm: 200 };
};
const allBirds = { exclude: [] };
const species = ( sciName: string ) => ( { sciName, include: [sciName], exclude: [] } );

const AVES = {
  id: 3, name: "Aves", rank_level: 50, ancestor_ids: [48460, 1, 2, 355675, 3],
};
const TURDUS = {
  id: 10, name: "Turdus", rank_level: 20, ancestor_ids: [1, 3, 10],
};
const ROBIN = {
  id: 11, name: "Turdus migratorius", rank_level: 10, ancestor_ids: [1, 3, 10, 11],
};
const THRUSHES = {
  id: 12, name: "Turdidae", rank_level: 30, ancestor_ids: [1, 3, 12],
};
const PLANTS = {
  id: 47126, name: "Plantae", rank_level: 70, ancestor_ids: [48460, 47126],
};
const taxa = [AVES, TURDUS, ROBIN, THRUSHES, PLANTS, { ...AVES, id: 1, name: "Animalia" }];
( searchTaxa as jest.Mock ).mockImplementation( ( { id, taxon_id: taxonId } ) => {
  if ( taxonId === THRUSHES.id ) return Promise.resolve( [TURDUS] );
  const ids = String( id ).split( "," ).map( Number );
  return Promise.resolve( taxa.filter( taxon => ids.includes( taxon.id ) ) );
} );

describe( "fetchEbirdObservations", ( ) => {
  beforeEach( ( ) => {
    mockFetch.mockClear( );
    resetEbirdRateLimit( );
  } );

  it( "looks up the species code and caps the distance at 50 km", async ( ) => {
    await fetchEbirdObservations( {
      ...area( ),
      taxonFilter: species( "Butorides virescens" ),
    } );
    const url = mockFetch.mock.calls.at( -1 )[0];
    expect( url ).toContain( "data/obs/geo/recent/grnher?" );
    expect( url ).toContain( "dist=50" );
    expect( url ).toContain( "maxResults=100" );
  } );

  it( "parses quoted common names containing commas", async ( ) => {
    await fetchEbirdObservations( {
      ...area( ),
      taxonFilter: species( "Some bird" ),
    } );
    expect( mockFetch.mock.calls.at( -1 )[0] ).toContain( "/oddher?" );
  } );

  it( "skips the request for species eBird doesn't know", async ( ) => {
    expect( await fetchEbirdObservations( {
      ...area( ),
      taxonFilter: species( "Not a bird" ),
    } ) ).toEqual( [] );
    expect( mockFetch ).not.toHaveBeenCalled( );
  } );

  it( "filters sightings by genus and species on the client", async ( ) => {
    const results = await fetchEbirdObservations( {
      ...area( ),
      taxonFilter: { include: ["Turdus"], exclude: ["Turdus merula"] },
    } );
    expect( results.map( obs => obs.subId ) ).toEqual( ["S2"] );
  } );

  it( "reuses results for a day instead of refetching", async ( ) => {
    const repeated = area( );
    await fetchEbirdObservations( { ...repeated, taxonFilter: allBirds } );
    await fetchEbirdObservations( { ...repeated, taxonFilter: allBirds } );
    expect( mockFetch ).toHaveBeenCalledTimes( 1 );
  } );

  it( "stops sending requests after 20 in 10 minutes", async ( ) => {
    await Promise.all( Array.from(
      { length: 20 },
      ( ) => fetchEbirdObservations( { ...area( ), taxonFilter: allBirds } ),
    ) );
    await expect( fetchEbirdObservations( { ...area( ), taxonFilter: allBirds } ) )
      .rejects.toThrow( EbirdRateLimitError );
    expect( mockFetch ).toHaveBeenCalledTimes( 20 );
  } );
} );

describe( "resolveEbirdTaxonFilter", ( ) => {
  it( "allows all birds without a taxon filter", async ( ) => {
    expect( await resolveEbirdTaxonFilter( {} ) ).toEqual( { exclude: [] } );
  } );

  it( "allows all birds for a taxon containing birds", async ( ) => {
    expect( await resolveEbirdTaxonFilter( { taxon_id: 1 } ) ).toEqual( { exclude: [] } );
  } );

  it( "allows only birds within a narrower taxon", async ( ) => {
    expect( await resolveEbirdTaxonFilter( { taxon_id: THRUSHES.id } ) )
      .toEqual( { sciName: undefined, include: ["Turdus"], exclude: [] } );
  } );

  it( "searches eBird for a single species directly", async ( ) => {
    expect( ( await resolveEbirdTaxonFilter( { taxon_id: ROBIN.id } ) )?.sciName )
      .toBe( "Turdus migratorius" );
  } );

  it( "keeps the bird taxa of a mixed filter", async ( ) => {
    expect( await resolveEbirdTaxonFilter( { taxon_id: `${PLANTS.id},${TURDUS.id}` } ) )
      .toEqual( { sciName: undefined, include: ["Turdus"], exclude: [] } );
  } );

  it( "excludes birds the filter excludes", async ( ) => {
    expect( await resolveEbirdTaxonFilter( { without_taxon_id: ROBIN.id } ) )
      .toEqual( { exclude: ["Turdus migratorius"] } );
  } );

  it( "skips eBird when the filters allow no birds", async ( ) => {
    expect( await resolveEbirdTaxonFilter( { taxon_id: PLANTS.id } ) ).toBeNull( );
    expect( await resolveEbirdTaxonFilter( { without_taxon_id: AVES.id } ) ).toBeNull( );
    expect( await resolveEbirdTaxonFilter( { iconic_taxa: ["Plantae"] } ) ).toBeNull( );
    expect( await resolveEbirdTaxonFilter( { user_id: 1 } ) ).toBeNull( );
  } );
} );
