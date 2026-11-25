import { act, screen } from "@testing-library/react-native";
import { Map } from "components/SharedComponents";
import { TILE_URL } from "components/SharedComponents/Map/helpers/mapHelpers";
import React from "react";
import faker from "tests/helpers/faker";
import { renderComponent } from "tests/helpers/render";

const baseUrl = `${TILE_URL}/grid/{z}/{x}/{y}.png`;
const pointsUrl = `${TILE_URL}/points/{z}/{x}/{y}.png`;

// The map shows individual points above zoom 13 and aggregate grid tiles below it
const ZOOMED_IN_DELTA = 0.02;
const ZOOMED_OUT_DELTA = 10;

const regionWithDelta = delta => ( {
  latitude: 0,
  longitude: 0,
  latitudeDelta: delta,
  longitudeDelta: delta,
} );

jest.mock( "sharedHooks/useLocationPermission", () => ( {
  __esModule: true,
  default: ( ) => ( {
    hasPermissions: true,
    renderPermissionsGate: jest.fn(),
    requestPermissions: jest.fn(),
  } ),
} ) );

describe( "Map", ( ) => {
  it( "should be accessible", ( ) => {
    // Disabled during the update to RN 0.78
    // expect( <Map /> ).toBeAccessible( );
  } );

  it( "displays filtered observations on map", async ( ) => {
    const taxonId = 1234;
    renderComponent(
      <Map
        withPressableObsTiles
        tileMapParams={{ taxon_id: taxonId }}
      />,
    );
    const tiles = await screen.findByTestId( "Map.UrlTile" );
    const { urlTemplate } = tiles.props;
    expect( urlTemplate )
      .toMatch( new RegExp( `^${baseUrl}.*taxon_id=${taxonId}` ) );
  } );

  it( "gives a search the same tile URL whatever area was searched", async ( ) => {
    renderComponent(
      <Map
        withPressableObsTiles
        tileMapParams={{
          taxon_id: 3,
          swlat: 1,
          swlng: 2,
          nelat: 3,
          nelng: 4,
          order_by: "votes",
          per_page: 20,
          iconic_taxa: undefined,
          d1: "2025-01-01",
        }}
      />,
    );
    const { urlTemplate } = ( await screen.findByTestId( "Map.UrlTile" ) ).props;
    // Paging, sorting, bounds and empty values left out, the rest in a fixed order
    expect( urlTemplate ).toBe( `${baseUrl}?d1=2025-01-01&taxon_id=3` );
  } );

  it( "caches observation tiles on disk", async ( ) => {
    renderComponent( <Map withPressableObsTiles tileMapParams={{ taxon_id: 3 }} /> );
    const tiles = await screen.findByTestId( "Map.UrlTile" );
    expect( tiles.props.tileCachePath ).toMatch( /observationTiles$/ );
    expect( tiles.props.offlineMode ).toBe( false );
  } );

  it( "displays location indicator when given an observation w/ lat/lng", async ( ) => {
    renderComponent(
      <Map
        showLocationIndicator
        observation={{
          latitude: Number( faker.location.latitude( ) ),
          longitude: Number( faker.location.longitude( ) ),
        }}
      />,
    );
    const testId = "Map.LocationIndicator";
    expect( screen.getByTestId( testId ) ).toBeTruthy();
  } );

  describe( "obs tile zoom level", ( ) => {
    const tileUrlTemplate = async ( ) => (
      await screen.findByTestId( "Map.UrlTile" )
    ).props.urlTemplate;

    it( "requests point tiles as soon as the map mounts zoomed in", async ( ) => {
      renderComponent(
        <Map
          withPressableObsTiles
          tileMapParams={{}}
          initialRegion={regionWithDelta( ZOOMED_IN_DELTA )}
        />,
      );

      expect( await tileUrlTemplate( ) ).toContain( pointsUrl );
    } );

    it( "goes back to grid tiles when the user zooms out", async ( ) => {
      renderComponent(
        <Map
          withPressableObsTiles
          tileMapParams={{}}
          initialRegion={regionWithDelta( ZOOMED_IN_DELTA )}
        />,
      );
      expect( await tileUrlTemplate( ) ).toContain( pointsUrl );

      await act( async ( ) => {
        await screen.getByTestId( "Map.MapView" ).props.onRegionChangeComplete(
          regionWithDelta( ZOOMED_OUT_DELTA ),
          {},
        );
      } );

      expect( await tileUrlTemplate( ) ).toContain( baseUrl );
    } );
  } );
} );
