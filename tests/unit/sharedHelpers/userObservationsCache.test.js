import { searchObservations } from "api/observations";
import {
  readLastSync,
  readUserObservationsCache,
  speciesIdFromTaxon,
  syncUserObservations,
} from "sharedHelpers/userObservationsCache";
import { zustandStorage } from "stores/useStore";

jest.mock( "api/observations", ( ) => ( {
  searchObservations: jest.fn( ),
} ) );

const USER_ID = 99;
const OPTS = { api_token: "token" };

const FAVE_VOTE = { id: 1, user_id: 7, vote_scope: null };
// A non-null scope is some other kind of vote, not a fave.
const NEEDS_ID_VOTE = { id: 2, user_id: 7, vote_scope: "needs_id" };

let nextObservationId = 0;

const makeApiObservation = ( {
  uuid, observedAt, votes = [], qualityGrade = "casual", taxon = { id: 1, rank_level: 10 },
} ) => {
  nextObservationId += 1;
  return {
    id: nextObservationId,
    uuid,
    time_observed_at: observedAt,
    votes,
    quality_grade: qualityGrade,
    taxon,
  };
};

const mockPages = ( ...pages ) => {
  pages.forEach( results => searchObservations.mockResolvedValueOnce( { results } ) );
};

beforeEach( ( ) => {
  searchObservations.mockReset( );
  zustandStorage.removeItem( `userObservations-v2-${USER_ID}` );
  zustandStorage.removeItem( `userObservationsLastSync-v2-${USER_ID}` );
} );

describe( "syncUserObservations", ( ) => {
  it( "caches capture time and fave status for the whole history", async ( ) => {
    mockPages( [
      makeApiObservation( {
        uuid: "faved",
        observedAt: "2026-07-16T12:00:00Z",
        votes: [FAVE_VOTE],
      } ),
      makeApiObservation( { uuid: "unfaved", observedAt: "2026-07-17T12:00:00Z" } ),
    ] );

    const cache = await syncUserObservations( USER_ID, OPTS );

    expect( cache.get( "faved" ).faved ).toBe( true );
    expect( cache.get( "faved" ).observedAtMs ).toEqual( Date.UTC( 2026, 6, 16, 12, 0, 0 ) );
    expect( cache.get( "unfaved" ).faved ).toBe( false );
  } );

  it( "does not treat a non-fave vote as a fave", async ( ) => {
    mockPages( [
      makeApiObservation( {
        uuid: "needs-id",
        observedAt: "2026-07-16T12:00:00Z",
        votes: [NEEDS_ID_VOTE],
      } ),
    ] );

    const cache = await syncUserObservations( USER_ID, OPTS );

    expect( cache.get( "needs-id" ).faved ).toBe( false );
  } );

  it( "only asks for what changed once a sync has been recorded", async ( ) => {
    mockPages(
      [makeApiObservation( { uuid: "old", observedAt: "2026-07-16T12:00:00Z" } )],
      [makeApiObservation( {
        uuid: "old",
        observedAt: "2026-07-16T12:00:00Z",
        votes: [FAVE_VOTE],
      } )],
    );

    await syncUserObservations( USER_ID, OPTS );
    const cache = await syncUserObservations( USER_ID, OPTS );

    expect( searchObservations ).toHaveBeenLastCalledWith(
      expect.objectContaining( { updated_since: expect.any( String ) } ),
      expect.objectContaining( OPTS ),
    );
    // The second pass only returned the one changed observation, but it merged
    // into what the first pass cached rather than replacing it.
    expect( cache.get( "old" ).faved ).toBe( true );
    expect( cache.size ).toEqual( 1 );
  } );

  it( "survives a restart by reading the cache back from storage", async ( ) => {
    mockPages( [makeApiObservation( {
      uuid: "faved",
      observedAt: "2026-07-16T12:00:00Z",
      votes: [FAVE_VOTE],
      qualityGrade: "research",
    } )] );

    await syncUserObservations( USER_ID, OPTS );
    const cache = readUserObservationsCache( USER_ID );

    expect( cache.get( "faved" ) ).toEqual( {
      uuid: "faved",
      observedAtMs: Date.UTC( 2026, 6, 16, 12, 0, 0 ),
      faved: true,
      researchGrade: true,
      taxonId: 1,
      rankLevel: 10,
      speciesId: 1,
    } );
  } );

  // Rock Pigeons on the street are usually identified as the domestic variety,
  // which is a rank below species. Without this the species reads as never
  // observed, and the next observation identified as plain Columba livia turns
  // up in My Lifers as though it were the first one.
  it( "records a below-species identification as an observation of the species", async ( ) => {
    mockPages( [makeApiObservation( {
      uuid: "feral-pigeon",
      observedAt: "2020-07-16T12:00:00Z",
      qualityGrade: "research",
      taxon: {
        id: 122767,
        rank_level: 5,
        ancestor_ids: [3, 2708, 2715, 3000, 3017, 122767],
      },
    } )] );

    const cache = await syncUserObservations( USER_ID, OPTS );

    expect( cache.get( "feral-pigeon" ).taxonId ).toEqual( 122767 );
    expect( cache.get( "feral-pigeon" ).speciesId ).toEqual( 3017 );
  } );

  // Otherwise the observations that never arrived would be skipped forever by
  // every later updated_since request.
  it( "does not record the sync when a page can't be read", async ( ) => {
    searchObservations.mockResolvedValueOnce( { } );

    await syncUserObservations( USER_ID, OPTS );

    expect( readLastSync( USER_ID ) ).toBeNull( );
  } );

  it( "hands each raw page to the caller so one pass serves everyone", async ( ) => {
    const onPage = jest.fn( );
    mockPages( [makeApiObservation( { uuid: "one", observedAt: "2026-07-16T12:00:00Z" } )] );

    await syncUserObservations( USER_ID, OPTS, { onPage } );

    expect( onPage ).toHaveBeenCalledTimes( 1 );
    expect( onPage.mock.calls[0][0][0].uuid ).toEqual( "one" );
  } );

  // The API's page param stops working past 10,000 results, which is the whole
  // reason this pages by cursor: a history longer than that could never finish
  // a first sync, so Delete Unfaved never saw the older half of it.
  it( "pages by id_above rather than the page param", async ( ) => {
    const firstPage = Array.from( { length: 200 }, ( _, i ) => makeApiObservation( {
      uuid: `first-${i}`,
      observedAt: "2026-07-16T12:00:00Z",
    } ) );
    mockPages(
      firstPage,
      [makeApiObservation( { uuid: "last", observedAt: "2026-07-17T12:00:00Z" } )],
    );

    const cache = await syncUserObservations( USER_ID, OPTS );

    expect( searchObservations ).toHaveBeenCalledTimes( 2 );
    expect( searchObservations.mock.calls[0][0].page ).toBeUndefined( );
    expect( searchObservations.mock.calls[0][0].id_above ).toBeUndefined( );
    expect( searchObservations.mock.calls[1][0].id_above )
      .toEqual( firstPage[firstPage.length - 1].id );
    expect( cache.size ).toEqual( 201 );
  } );

  // Otherwise a long history that keeps being interrupted starts from nothing
  // every time and the cache stays permanently empty.
  it( "keeps the pages that landed when a later one fails", async ( ) => {
    const firstPage = Array.from( { length: 200 }, ( _, i ) => makeApiObservation( {
      uuid: `first-${i}`,
      observedAt: "2026-07-16T12:00:00Z",
    } ) );
    searchObservations
      .mockResolvedValueOnce( { results: firstPage } )
      .mockRejectedValueOnce( new Error( "boom" ) );

    await expect( syncUserObservations( USER_ID, OPTS ) ).rejects.toThrow( "boom" );

    expect( readUserObservationsCache( USER_ID ).size ).toEqual( 200 );
    // Not recorded, so the next run re-fetches from the top rather than
    // skipping everything that never arrived.
    expect( readLastSync( USER_ID ) ).toBeNull( );
  } );

  it( "gives each page its own abort signal instead of reusing the caller's", async ( ) => {
    // The caller's signal is sized for a single request. Paging a whole
    // history with it aborts every page after the timeout, so the sync can
    // never finish and My Lifers has nothing to show.
    const controller = new AbortController( );
    controller.abort( );
    mockPages(
      Array.from( { length: 200 }, ( _, i ) => makeApiObservation( {
        uuid: `first-${i}`,
        observedAt: "2026-07-16T12:00:00Z",
      } ) ),
      [makeApiObservation( { uuid: "second", observedAt: "2026-07-17T12:00:00Z" } )],
    );

    const cache = await syncUserObservations( USER_ID, { ...OPTS, signal: controller.signal } );

    expect( cache.get( "second" ) ).toBeTruthy( );
    searchObservations.mock.calls.forEach( ( [, opts] ) => {
      expect( opts.signal ).toBeDefined( );
      expect( opts.signal.aborted ).toBe( false );
    } );
  } );

  it( "does nothing without a signed in user", async ( ) => {
    await expect( syncUserObservations( null, OPTS ) ).resolves.toEqual( new Map( ) );
    expect( searchObservations ).not.toHaveBeenCalled( );
  } );
} );

describe( "speciesIdFromTaxon", ( ) => {
  it( "is the taxon itself at species level", ( ) => {
    expect( speciesIdFromTaxon( { id: 3017, rank_level: 10 } ) ).toEqual( 3017 );
  } );

  it( "is the parent species for a subspecies, variety, or form", ( ) => {
    expect( speciesIdFromTaxon( {
      id: 122767,
      rank_level: 5,
      ancestor_ids: [3, 2708, 2715, 3000, 3017, 122767],
    } ) ).toEqual( 3017 );
  } );

  it( "is nothing for an identification coarser than a species", ( ) => {
    expect( speciesIdFromTaxon( {
      id: 3000,
      rank_level: 20,
      ancestor_ids: [3, 2708, 2715, 3000],
    } ) ).toBeNull( );
  } );

  // Nothing to roll up to, so it can't count as any species in particular.
  it( "is nothing for a below-species taxon with no ancestry", ( ) => {
    expect( speciesIdFromTaxon( { id: 122767, rank_level: 5 } ) ).toBeNull( );
  } );

  it( "is nothing without a taxon", ( ) => {
    expect( speciesIdFromTaxon( null ) ).toBeNull( );
    expect( speciesIdFromTaxon( { id: 3017 } ) ).toBeNull( );
  } );
} );
