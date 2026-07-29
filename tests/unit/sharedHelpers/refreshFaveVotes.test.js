import { searchObservations } from "api/observations";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import refreshFaveVotes from "sharedHelpers/refreshFaveVotes";

jest.mock( "api/observations", ( ) => ( {
  searchObservations: jest.fn( ),
} ) );

jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  getJWT: jest.fn( ( ) => Promise.resolve( "token" ) ),
} ) );

const USER_ID = 99;

const makeRealmObservation = votes => ( {
  isValid: ( ) => true,
  votes,
} );

// Minimal stand-in for Realm: a uuid -> observation map, plus the locally faved
// query used to clear faves the server didn't return.
const makeRealm = observationsByUuid => {
  Object.entries( observationsByUuid ).forEach( ( [uuid, observation] ) => {
    observation.uuid = uuid;
  } );
  return {
    isInTransaction: true,
    objectForPrimaryKey: ( _type, uuid ) => observationsByUuid[uuid] || null,
    objects: ( ) => ( {
      filtered: ( ) => Object.values( observationsByUuid )
        .filter( observation => observation.votes?.length > 0 ),
    } ),
  };
};

const mockResults = results => {
  searchObservations.mockResolvedValueOnce( { results } );
};

beforeEach( ( ) => {
  searchObservations.mockReset( );
  getJWT.mockResolvedValue( "token" );
} );

describe( "refreshFaveVotes", ( ) => {
  // Only faved observations come back, so an observation missing from the
  // results is how we learn its fave is gone.
  it( "clears a local fave the server no longer lists as faved", async ( ) => {
    const observation = makeRealmObservation( [
      {
        id: 1, user_id: USER_ID, vote_flag: true, vote_scope: null,
      },
    ] );
    const realm = makeRealm( { "uuid-1": observation } );
    mockResults( [] );

    const updated = await refreshFaveVotes( realm, USER_ID );

    expect( updated ).toEqual( 1 );
    expect( observation.votes ).toEqual( [] );
  } );

  it( "only asks the server for faved observations", async ( ) => {
    mockResults( [] );

    await refreshFaveVotes( makeRealm( { } ), USER_ID );

    expect( searchObservations ).toHaveBeenCalledWith(
      expect.objectContaining( { popular: true, user_id: USER_ID } ),
      expect.anything( ),
    );
  } );

  it( "adds a fave made on another device", async ( ) => {
    const observation = makeRealmObservation( [] );
    const realm = makeRealm( { "uuid-1": observation } );
    mockResults( [{
      uuid: "uuid-1",
      votes: [{
        id: 7, user_id: USER_ID, vote_flag: true, vote_scope: null,
      }],
    }] );

    await refreshFaveVotes( realm, USER_ID );

    expect( observation.votes ).toHaveLength( 1 );
    expect( observation.votes[0].id ).toEqual( 7 );
  } );

  it( "leaves unchanged votes alone", async ( ) => {
    const votes = [{
      id: 1, user_id: USER_ID, vote_flag: true, vote_scope: null,
    }];
    const observation = makeRealmObservation( votes );
    const realm = makeRealm( { "uuid-1": observation } );
    mockResults( [{ uuid: "uuid-1", votes }] );

    const updated = await refreshFaveVotes( realm, USER_ID );

    expect( updated ).toEqual( 0 );
    expect( observation.votes ).toBe( votes );
  } );

  it( "ignores observations that aren't stored locally", async ( ) => {
    const realm = makeRealm( { } );
    mockResults( [{ uuid: "not-local", votes: [] }] );

    await expect( refreshFaveVotes( realm, USER_ID ) ).resolves.toEqual( 0 );
  } );

  it( "does nothing without a signed in user", async ( ) => {
    const realm = makeRealm( { } );

    await expect( refreshFaveVotes( realm, null ) ).resolves.toEqual( 0 );
    expect( searchObservations ).not.toHaveBeenCalled( );
  } );

  it( "falls back to local votes when the request fails", async ( ) => {
    const votes = [{
      id: 1, user_id: USER_ID, vote_flag: true, vote_scope: null,
    }];
    const observation = makeRealmObservation( votes );
    const realm = makeRealm( { "uuid-1": observation } );
    searchObservations.mockRejectedValueOnce( new Error( "network" ) );

    await expect( refreshFaveVotes( realm, USER_ID ) ).resolves.toEqual( 0 );
    expect( observation.votes ).toBe( votes );
  } );
} );
