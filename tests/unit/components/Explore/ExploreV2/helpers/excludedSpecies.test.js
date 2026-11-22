import { fetchSpeciesCounts } from "api/observations";
import { roundNearbyCoords } from "components/Explore/ExploreV2/helpers/buildQueryParams";
import {
  referencedSavedSearches,
  resolveExcludedSpeciesIds,
} from "components/Explore/ExploreV2/helpers/excludedSpecies";
import { defaultExploreV2Filters, EXPLORE_V2_PLACE_MODE } from "providers/ExploreV2Context";
import { savedSearch } from "tests/helpers/savedSearch";

jest.mock( "api/observations", ( ) => ( {
  fetchSpeciesCounts: jest.fn( ),
} ) );

const SPECIES_LEVEL = 10;

const species = id => ( { taxon: { id, rank_level: SPECIES_LEVEL, ancestor_ids: [1, id] } } );
const subspecies = ( id, speciesId ) => ( {
  taxon: { id, rank_level: 5, ancestor_ids: [1, speciesId, id] },
} );

const named = ( name, filters = {}, overrides = {} ) => ( {
  ...savedSearch( { filters: { ...defaultExploreV2Filters, ...filters }, ...overrides } ),
  key: `saved-${name}`,
  name,
} );

const excluding = name => ( {
  subject: null,
  filters: { ...defaultExploreV2Filters, excludeSpeciesInSavedSearch: name },
} );

const context = ( savedSearches, overrides = {} ) => ( {
  savedSearches,
  apiToken: "token",
  currentUserId: 1,
  getNearbyCoords: async ( ) => ( { lat: 1, lng: 2 } ),
  ...overrides,
} );

beforeEach( ( ) => {
  fetchSpeciesCounts.mockReset( );
} );

describe( "resolveExcludedSpeciesIds", ( ) => {
  it( "leaves nothing out when the search excludes nothing", async ( ) => {
    const ids = await resolveExcludedSpeciesIds(
      { subject: null, filters: defaultExploreV2Filters },
      context( [] ),
    );
    expect( ids ).toEqual( [] );
    expect( fetchSpeciesCounts ).not.toHaveBeenCalled( );
  } );

  it( "leaves out the species a saved search finds, by its current contents", async ( ) => {
    fetchSpeciesCounts.mockResolvedValue( {
      total_results: 3,
      results: [species( 10 ), subspecies( 11, 12 ), species( 10 )],
    } );
    const backyard = named( "Backyard", {}, { subject: { type: "taxon", taxon: { id: 47 } } } );

    const ids = await resolveExcludedSpeciesIds( excluding( "backyard" ), context( [backyard] ) );

    expect( ids.sort( ) ).toEqual( [10, 12] );
    expect( fetchSpeciesCounts.mock.calls[0][0] ).toMatchObject( { taxon_id: 47, page: 1 } );
    expect( fetchSpeciesCounts.mock.calls[0][0] ).not.toHaveProperty( "order_by" );
  } );

  it( "pages through every species", async ( ) => {
    const page = start => Array.from( { length: 500 }, ( _, i ) => species( start + i ) );
    fetchSpeciesCounts
      .mockResolvedValueOnce( { total_results: 600, results: page( 1000 ) } )
      .mockResolvedValueOnce( { total_results: 600, results: page( 2000 ).slice( 0, 100 ) } );

    const ids = await resolveExcludedSpeciesIds(
      excluding( "Big" ),
      context( [named( "Big" )] ),
    );

    expect( fetchSpeciesCounts ).toHaveBeenCalledTimes( 2 );
    expect( ids ).toHaveLength( 600 );
  } );

  it( "fails clearly when no saved search has the name, e.g. after a rename", async ( ) => {
    await expect( resolveExcludedSpeciesIds(
      excluding( "Backyard" ),
      context( [named( "Back yard" )] ),
    ) ).rejects.toMatchObject( { reason: "missing", savedSearchName: "Backyard" } );
    expect( fetchSpeciesCounts ).not.toHaveBeenCalled( );
  } );

  it( "fails when saved searches exclude each other", async ( ) => {
    const a = named( "A", { excludeSpeciesInSavedSearch: "B" } );
    const b = named( "B", { excludeSpeciesInSavedSearch: "A" } );
    await expect( resolveExcludedSpeciesIds( excluding( "A" ), context( [a, b] ) ) )
      .rejects.toMatchObject( { reason: "cycle" } );
  } );

  it( "fails offline rather than ignoring the saved search", async ( ) => {
    await expect( resolveExcludedSpeciesIds(
      excluding( "A" ),
      context( [named( "A" )], { offline: true } ),
    ) ).rejects.toMatchObject( { reason: "offline" } );
  } );

  it( "applies a saved search's own exclusions when finding its species", async ( ) => {
    fetchSpeciesCounts
      .mockResolvedValueOnce( { total_results: 1, results: [species( 77 )] } )
      .mockResolvedValueOnce( { total_results: 1, results: [species( 10 )] } );
    const mine = named( "Mine", {}, { subject: null } );
    const notMine = named( "Not mine", { excludeSpeciesInSavedSearch: "Mine" } );

    const ids = await resolveExcludedSpeciesIds(
      excluding( "Not mine" ),
      context( [mine, notMine] ),
    );

    expect( ids ).toEqual( [10] );
    expect( fetchSpeciesCounts.mock.calls[1][0].without_taxon_id ).toEqual( "77" );
  } );

  it( "fails rather than truncating more than 10,000 species", async ( ) => {
    fetchSpeciesCounts.mockResolvedValue( {
      total_results: 10001,
      results: Array.from( { length: 500 }, ( _, i ) => species( i + 1 ) ),
    } );

    await expect( resolveExcludedSpeciesIds(
      excluding( "Everything" ),
      context( [named( "Everything" )] ),
    ) ).rejects.toMatchObject( { reason: "too-many", savedSearchName: "Everything" } );
    expect( fetchSpeciesCounts ).toHaveBeenCalledTimes( 1 );
  } );

  it( "fetches exactly 10,000 species", async ( ) => {
    let next = 0;
    fetchSpeciesCounts.mockImplementation( async ( ) => ( {
      total_results: 10000,
      results: Array.from( { length: 500 }, ( ) => { next += 1; return species( next ); } ),
    } ) );

    const ids = await resolveExcludedSpeciesIds(
      excluding( "Big" ),
      context( [named( "Big" )] ),
    );

    expect( fetchSpeciesCounts ).toHaveBeenCalledTimes( 20 );
    expect( ids ).toHaveLength( 10000 );
  } );

  it( "searches a nearby saved search around the current location", async ( ) => {
    fetchSpeciesCounts.mockResolvedValue( { total_results: 0, results: [] } );
    const nearby = named( "Nearby", {}, {
      location: { placeMode: EXPLORE_V2_PLACE_MODE.NEARBY, radius: 5 },
    } );

    await resolveExcludedSpeciesIds( excluding( "Nearby" ), context( [nearby] ) );

    expect( fetchSpeciesCounts.mock.calls[0][0] ).toMatchObject( {
      ...roundNearbyCoords( { lat: 1, lng: 2 } ),
      radius: 5,
    } );
  } );
} );

describe( "referencedSavedSearches", ( ) => {
  it( "follows the chain of names and stops at a loop", ( ) => {
    const a = named( "A", { excludeSpeciesInSavedSearch: "B" } );
    const b = named( "B", { excludeSpeciesInSavedSearch: "A" } );
    expect( referencedSavedSearches( excluding( "A" ), [a, b] ) ).toEqual( [a, b] );
    expect( referencedSavedSearches( excluding( "C" ), [a, b] ) ).toEqual( [] );
  } );
} );
