import {
  EbirdRateLimitError,
  fetchEbirdObservations,
  resetEbirdRateLimit,
} from "api/ebird";

jest.mock( "react-native-config", ( ) => ( { EBIRD_API_KEY: "test-key" } ) );

const TAXONOMY_CSV = "SCIENTIFIC_NAME,COMMON_NAME,SPECIES_CODE,CATEGORY\n"
  + "Butorides virescens,Green Heron,grnher,species\n"
  + "Some bird,\"Heron, Odd\",oddher,species\n";

const mockFetch = jest.fn( ( url: string ) => Promise.resolve( {
  ok: true,
  status: 200,
  text: ( ) => Promise.resolve( TAXONOMY_CSV ),
  json: ( ) => Promise.resolve( [{ subId: "S1", url }] ),
} ) );
global.fetch = mockFetch as unknown as typeof fetch;

const params = { lat: 47, lng: -122, distKm: 200 };

describe( "fetchEbirdObservations", ( ) => {
  beforeEach( ( ) => {
    mockFetch.mockClear( );
    resetEbirdRateLimit( );
  } );

  it( "looks up the species code and caps the distance at 50 km", async ( ) => {
    const results = await fetchEbirdObservations( { ...params, sciName: "Butorides virescens" } );
    const url = mockFetch.mock.calls[1][0];
    expect( url ).toContain( "data/obs/geo/recent/grnher?" );
    expect( url ).toContain( "dist=50" );
    expect( url ).toContain( "maxResults=100" );
    expect( results ).toHaveLength( 1 );
  } );

  it( "parses quoted common names containing commas", async ( ) => {
    await fetchEbirdObservations( { ...params, sciName: "Some bird" } );
    expect( mockFetch.mock.calls.at( -1 )[0] ).toContain( "/oddher?" );
  } );

  it( "skips the request for species eBird doesn't know", async ( ) => {
    expect( await fetchEbirdObservations( { ...params, sciName: "Not a bird" } ) ).toEqual( [] );
  } );

  it( "stops sending requests after 20 in 10 minutes", async ( ) => {
    await Promise.all( Array.from( { length: 20 }, ( ) => fetchEbirdObservations( params ) ) );
    await expect( fetchEbirdObservations( params ) ).rejects.toThrow( EbirdRateLimitError );
    expect( mockFetch ).toHaveBeenCalledTimes( 20 );
  } );
} );
