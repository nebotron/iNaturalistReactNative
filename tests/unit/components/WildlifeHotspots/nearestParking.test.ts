import { findNearestParking } from "components/WildlifeHotspots/nearestParking";

const mockFetch = jest.fn( ( _url: string, _init?: { body?: string } ) => Promise.resolve( {
  ok: true,
  json: ( ) => Promise.resolve( {
    elements: [
      // A node about 400 m north of the first hotspot
      { type: "node", lat: 37.7736, lon: -122.42 },
      // A way, which carries its center, about 1.1 km north
      { type: "way", center: { lat: 37.78, lon: -122.42 } },
    ],
  } ),
} ) );

describe( "findNearestParking", ( ) => {
  beforeAll( ( ) => {
    global.fetch = mockFetch as unknown as typeof fetch;
  } );

  it( "picks the nearest lot within each hotspot's radius, or none", async ( ) => {
    const parking = await findNearestParking( [
      { latitude: 37.77, longitude: -122.42, radiusKm: 0.5 },
      // Far from every lot
      { latitude: 38.5, longitude: -121.5, radiusKm: 0.5 },
    ] );
    expect( parking ).toEqual( [{ latitude: 37.7736, longitude: -122.42 }, null] );
    expect( mockFetch ).toHaveBeenCalledTimes( 1 );
    expect( decodeURIComponent( String( mockFetch.mock.calls[0][1]?.body ) ) )
      .toContain( "around:1500,37.7700,-122.4200" );
  } );
} );
