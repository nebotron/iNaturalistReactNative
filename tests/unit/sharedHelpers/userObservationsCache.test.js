import { searchObservations } from "api/observations";
import {
  readLastSync,
  readUserObservationsCache,
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

const makeApiObservation = ( {
  uuid, observedAt, votes = [], qualityGrade = "casual",
} ) => ( {
  uuid,
  time_observed_at: observedAt,
  votes,
  quality_grade: qualityGrade,
  taxon: { id: 1, rank_level: 10 },
} );

const mockPages = ( ...pages ) => {
  pages.forEach( results => searchObservations.mockResolvedValueOnce( { results } ) );
};

beforeEach( ( ) => {
  searchObservations.mockReset( );
  zustandStorage.removeItem( `userObservations-v1-${USER_ID}` );
  zustandStorage.removeItem( `userObservationsLastSync-v1-${USER_ID}` );
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
      OPTS,
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
    } );
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

  it( "does nothing without a signed in user", async ( ) => {
    await expect( syncUserObservations( null, OPTS ) ).resolves.toEqual( new Map( ) );
    expect( searchObservations ).not.toHaveBeenCalled( );
  } );
} );
