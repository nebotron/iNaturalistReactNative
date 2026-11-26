import buildExploreQueryParams, {
  roundNearbyCoords,
} from "components/Explore/helpers/buildQueryParams";
import {
  EXPLORE_PLACE_MODE,
  initialExploreState,
} from "providers/ExploreContext";
import { OBSERVATIONS_SORT } from "sharedHelpers/observationsSort";

describe( "buildExploreQueryParams", ( ) => {
  describe( "subject filter", ( ) => {
    it( "maps a selected taxon to taxon_id", ( ) => {
      const state = {
        ...initialExploreState,
        subject: { type: "taxon", taxon: { id: 42 } },
      };
      const params = buildExploreQueryParams( state );
      expect( params.taxon_id ).toBe( 42 );
      expect( params.user_id ).toBeUndefined( );
      expect( params.project_id ).toBeUndefined( );
    } );

    it( "adds included and excluded taxa from the taxon filters", ( ) => {
      const state = {
        ...initialExploreState,
        subject: { type: "taxon", taxon: { id: 42 } },
        filters: {
          ...initialExploreState.filters,
          taxonFilters: [
            { taxon: { id: 3 }, exclude: false },
            { taxon: { id: 7 }, exclude: true },
          ],
        },
      };
      const params = buildExploreQueryParams( state );
      expect( params.taxon_id ).toBe( "42,3" );
      expect( params.without_taxon_id ).toBe( 7 );
    } );

    it( "maps a selected user to user_id", ( ) => {
      const state = {
        ...initialExploreState,
        subject: { type: "user", user: { id: 7 } },
      };
      const params = buildExploreQueryParams( state );
      expect( params.user_id ).toBe( 7 );
      expect( params.taxon_id ).toBeUndefined( );
    } );

    it( "maps a selected project to project_id", ( ) => {
      const state = {
        ...initialExploreState,
        subject: { type: "project", project: { id: 12 } },
      };
      const params = buildExploreQueryParams( state );
      expect( params.project_id ).toBe( 12 );
    } );

    it( "excludes the species of a saved search", ( ) => {
      const state = {
        ...initialExploreState,
        filters: {
          ...initialExploreState.filters,
          excludeSpeciesInSavedSearch: "Backyard",
          taxonFilters: [{ taxon: { id: 3 }, exclude: true }],
        },
      };
      const params = buildExploreQueryParams( state, undefined, 99, [3, 8] );
      expect( params.without_taxon_id ).toBe( "3,8" );
    } );

    it( "maps an unknown subject to iconic_taxa=[unknown]", ( ) => {
      const state = {
        ...initialExploreState,
        subject: { type: "unknown" },
      };
      const params = buildExploreQueryParams( state );
      expect( params.iconic_taxa ).toEqual( ["unknown"] );
      expect( params.identified ).toBe( false );
      expect( params.taxon_id ).toBeUndefined( );
      expect( params.verifiable ).toBe( true );
    } );
  } );

  describe( "location", ( ) => {
    it( "includes lat/lng/radius in NEARBY mode when coords are resolved", ( ) => {
      const state = {
        ...initialExploreState,
        location: { placeMode: EXPLORE_PLACE_MODE.NEARBY },
      };
      const params = buildExploreQueryParams( state, {
        lat: 37.5,
        lng: -122.1,
        radius: 1,
      } );
      expect( params.lat ).toBeCloseTo( 37.5, 3 );
      expect( params.lng ).toBeCloseTo( -122.1, 3 );
      expect( params.radius ).toBe( 1 );
      expect( params.place_id ).toBeUndefined( );
    } );

    it( "rounds the nearby location to the nearest 100 m", ( ) => {
      const state = {
        ...initialExploreState,
        location: { placeMode: EXPLORE_PLACE_MODE.NEARBY },
      };
      const here = buildExploreQueryParams( state, { lat: 37.50001, lng: -122.10001 } );
      // About 20 m away
      const nextDoor = buildExploreQueryParams( state, { lat: 37.50017, lng: -122.10001 } );
      expect( nextDoor.lat ).toBe( here.lat );
      expect( nextDoor.lng ).toBe( here.lng );
    } );
  } );

  describe( "roundNearbyCoords", ( ) => {
    const metersBetween = ( a, b ) => {
      const dLat = ( a.lat - b.lat ) * 111320;
      const dLng = ( a.lng - b.lng ) * 111320 * Math.cos( a.lat * ( Math.PI / 180 ) );
      return Math.hypot( dLat, dLng );
    };

    it.each( [
      [0, 0],
      [37.5123, -122.1456],
      [-33.86, 151.21],
      [64.1466, -21.9426],
    ] )( "moves (%s, %s) no more than ~71 m, half a 100 m cell's diagonal", ( lat, lng ) => {
      const rounded = roundNearbyCoords( { lat, lng } );
      expect( metersBetween( { lat, lng }, rounded ) ).toBeLessThanOrEqual( 71 );
    } );

    it( "puts points 200 m apart in different cells", ( ) => {
      const a = roundNearbyCoords( { lat: 37.5, lng: -122.1 } );
      const b = roundNearbyCoords( { lat: 37.5 + 200 / 111320, lng: -122.1 } );
      expect( b.lat ).not.toBe( a.lat );
    } );

    it( "returns the same values for a point already on the grid", ( ) => {
      const once = roundNearbyCoords( { lat: 37.5123, lng: -122.1456 } );
      expect( roundNearbyCoords( once ) ).toEqual( once );
    } );

    it( "omits coords in NEARBY mode when coords are unresolved (worldwide fallback)", ( ) => {
      const state = {
        ...initialExploreState,
        location: { placeMode: EXPLORE_PLACE_MODE.NEARBY },
      };
      const params = buildExploreQueryParams( state );
      expect( params.lat ).toBeUndefined( );
      expect( params.lng ).toBeUndefined( );
      expect( params.radius ).toBeUndefined( );
      expect( params.place_id ).toBeUndefined( );
    } );

    it( "omits coords and place in WORLDWIDE mode", ( ) => {
      const state = {
        ...initialExploreState,
        location: { placeMode: EXPLORE_PLACE_MODE.WORLDWIDE },
      };
      const params = buildExploreQueryParams( state );
      expect( params.lat ).toBeUndefined( );
      expect( params.place_id ).toBeUndefined( );
    } );

    it( "uses place_id in PLACE mode", ( ) => {
      const state = {
        ...initialExploreState,
        location: {
          placeMode: EXPLORE_PLACE_MODE.PLACE,
          place: { id: 5 },
        },
      };
      const params = buildExploreQueryParams( state );
      expect( params.place_id ).toBe( 5 );
      expect( params.lat ).toBeUndefined( );
    } );

    it( "uses the bounding box in MAP_AREA mode", ( ) => {
      const state = {
        ...initialExploreState,
        location: {
          placeMode: EXPLORE_PLACE_MODE.MAP_AREA,
          bounds: {
            swlat: 10, swlng: 20, nelat: 30, nelng: 40,
          },
        },
      };
      const params = buildExploreQueryParams( state );
      expect( params.swlat ).toBe( 10 );
      expect( params.swlng ).toBe( 20 );
      expect( params.nelat ).toBe( 30 );
      expect( params.nelng ).toBe( 40 );
    } );

    it( "omits coords and place in MAP_AREA mode, even with nearby coords resolved", ( ) => {
      const state = {
        ...initialExploreState,
        location: {
          placeMode: EXPLORE_PLACE_MODE.MAP_AREA,
          bounds: {
            swlat: 10, swlng: 20, nelat: 30, nelng: 40,
          },
        },
      };
      const params = buildExploreQueryParams( state, {
        lat: 37.5,
        lng: -122.1,
        radius: 1,
      } );
      expect( params.lat ).toBeUndefined( );
      expect( params.lng ).toBeUndefined( );
      expect( params.radius ).toBeUndefined( );
      expect( params.place_id ).toBeUndefined( );
    } );
  } );

  describe( "sort", ( ) => {
    it( "DATE_UPLOADED_NEWEST → created_at desc", ( ) => {
      const params = buildExploreQueryParams( {
        ...initialExploreState,
        sortBy: OBSERVATIONS_SORT.DATE_UPLOADED_NEWEST,
      } );
      expect( params.order_by ).toBe( "created_at" );
      expect( params.order ).toBe( "desc" );
    } );

    it( "DATE_UPLOADED_OLDEST → created_at asc", ( ) => {
      const params = buildExploreQueryParams( {
        ...initialExploreState,
        sortBy: OBSERVATIONS_SORT.DATE_UPLOADED_OLDEST,
      } );
      expect( params.order_by ).toBe( "created_at" );
      expect( params.order ).toBe( "asc" );
    } );

    it( "DATE_OBSERVED_NEWEST → observed_on desc", ( ) => {
      const params = buildExploreQueryParams( {
        ...initialExploreState,
        sortBy: OBSERVATIONS_SORT.DATE_OBSERVED_NEWEST,
      } );
      expect( params.order_by ).toBe( "observed_on" );
      expect( params.order ).toBe( "desc" );
    } );

    it( "DATE_OBSERVED_OLDEST → observed_on asc", ( ) => {
      const params = buildExploreQueryParams( {
        ...initialExploreState,
        sortBy: OBSERVATIONS_SORT.DATE_OBSERVED_OLDEST,
      } );
      expect( params.order_by ).toBe( "observed_on" );
      expect( params.order ).toBe( "asc" );
    } );

    it( "MOST_FAVED → votes desc", ( ) => {
      const params = buildExploreQueryParams( {
        ...initialExploreState,
        sortBy: OBSERVATIONS_SORT.MOST_FAVED,
      } );
      expect( params.order_by ).toBe( "votes" );
      expect( params.order ).toBe( "desc" );
    } );
  } );

  it( "always sets per_page to 20 and verifiable to true", ( ) => {
    const params = buildExploreQueryParams( initialExploreState );
    expect( params.per_page ).toBe( 20 );
    expect( params.verifiable ).toBe( true );
  } );

  it( "applies sort order to the default state", ( ) => {
    const params = buildExploreQueryParams( initialExploreState );
    expect( params.order_by ).toBe( "created_at" );
    expect( params.order ).toBe( "desc" );
  } );

  it( "combines subject, location, and sort into a single query", ( ) => {
    const state = {
      subject: { type: "taxon", taxon: { id: 42 } },
      location: { placeMode: EXPLORE_PLACE_MODE.NEARBY },
      sortBy: OBSERVATIONS_SORT.DATE_UPLOADED_NEWEST,
      filters: {},
    };
    const params = buildExploreQueryParams( state, {
      lat: 37.5,
      lng: -122.1,
      radius: 1,
    } );
    expect( params ).toEqual( {
      per_page: 20,
      verifiable: true,
      order_by: "created_at",
      order: "desc",
      taxon_id: 42,
      ...roundNearbyCoords( { lat: 37.5, lng: -122.1 } ),
      radius: 1,
    } );
  } );
} );
