import { act, renderHook } from "@testing-library/react-native";
import { searchObservations } from "api/observations";
import { useRouteHotspots } from "components/WildlifeHotspots/hooks/useRouteHotspots";

jest.mock( "api/observations", ( ) => ( {
  searchObservations: jest.fn( ( ) => Promise.resolve( { results: [] } ) ),
} ) );

const stops = [
  { latitude: 37.77, longitude: -122.42 },
  { latitude: 37.8, longitude: -122.27 },
];

const mockFetch = jest.fn( ( url: string ) => Promise.resolve( {
  ok: true,
  json: ( ) => Promise.resolve( url.includes( "/table/" )
    ? { durations: [[0, 1], [1, 0]] }
    : {
      routes: [{
        duration: 600,
        // A straight line through the requested waypoints
        geometry: {
          coordinates: ( url.split( "/" ).pop( ) ?? "" ).split( "?" )[0].split( ";" )
            .map( pair => pair.split( "," ).map( Number ) ),
        },
      }],
    } ),
} ) );

describe( "useRouteHotspots", ( ) => {
  beforeAll( ( ) => {
    global.fetch = mockFetch as unknown as typeof fetch;
  } );

  it( "doesn't search iNaturalist again for the same route", async ( ) => {
    const { result } = renderHook( ( ) => useRouteHotspots( ) );
    await act( async ( ) => {
      await result.current.findHotspots( stops, { taxon_id: 3 } );
    } );
    expect( searchObservations ).toHaveBeenCalledTimes( 1 );

    // A slightly different start a few meters away, and a setting that only
    // changes clustering, still ask the same question
    await act( async ( ) => {
      await result.current.findHotspots(
        [{ latitude: 37.77001, longitude: -122.42001 }, stops[1]],
        { taxon_id: 3, hotspotClusterRadiusKm: 3 },
      );
    } );
    expect( searchObservations ).toHaveBeenCalledTimes( 1 );

    await act( async ( ) => {
      await result.current.findHotspots( stops, { taxon_id: 4 } );
    } );
    expect( searchObservations ).toHaveBeenCalledTimes( 2 );
  } );
} );
