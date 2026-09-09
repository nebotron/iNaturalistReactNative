import {
  clearNotificationsCache,
  getCachedNotifications,
  getCachedObservation,
  MAX_CACHED_NOTIFICATIONS,
  MAX_CACHED_OBSERVATIONS,
  setCachedNotifications,
  setCachedObservations,
} from "sharedHelpers/notificationsCache";

const OWNER = JSON.stringify( { observations_by: "owner" } );
const FOLLOWING = JSON.stringify( { observations_by: "following" } );

const makeNotifications = count => Array.from( { length: count }, ( _, i ) => ( {
  id: `notification-${i}`,
  resource_uuid: `uuid-${i}`,
} ) );

describe( "notificationsCache", ( ) => {
  beforeEach( ( ) => {
    clearNotificationsCache( );
  } );

  it( "returns nothing for a tab that was never cached", ( ) => {
    expect( getCachedNotifications( OWNER ) ).toBeUndefined( );
  } );

  it( "returns the notifications it was given, with a timestamp", ( ) => {
    const notifications = makeNotifications( 2 );
    setCachedNotifications( OWNER, notifications );

    const cached = getCachedNotifications( OWNER );
    expect( cached.value ).toEqual( notifications );
    expect( cached.cachedAt ).toBeLessThanOrEqual( Date.now( ) );
  } );

  it( "keeps each tab's notifications separate", ( ) => {
    setCachedNotifications( OWNER, makeNotifications( 1 ) );
    setCachedNotifications( FOLLOWING, makeNotifications( 3 ) );

    expect( getCachedNotifications( OWNER ).value ).toHaveLength( 1 );
    expect( getCachedNotifications( FOLLOWING ).value ).toHaveLength( 3 );
  } );

  it( "caches an empty list, so a cleared tab doesn't show stale notifications", ( ) => {
    setCachedNotifications( OWNER, makeNotifications( 2 ) );
    setCachedNotifications( OWNER, [] );

    expect( getCachedNotifications( OWNER ).value ).toEqual( [] );
  } );

  it( "stores no more than a page of notifications", ( ) => {
    setCachedNotifications( OWNER, makeNotifications( MAX_CACHED_NOTIFICATIONS + 10 ) );

    expect( getCachedNotifications( OWNER ).value ).toHaveLength( MAX_CACHED_NOTIFICATIONS );
  } );

  it( "returns an observation it cached", ( ) => {
    const observation = { uuid: "obs-uuid", comments: [{ id: 1 }] };
    setCachedObservations( [observation] );

    expect( getCachedObservation( "obs-uuid" ).value ).toEqual( observation );
  } );

  it( "evicts the least recently cached observations past the cap", ( ) => {
    const observations = Array.from(
      { length: MAX_CACHED_OBSERVATIONS + 1 },
      ( _, i ) => ( { uuid: `obs-${i}` } ),
    );
    observations.forEach( observation => setCachedObservations( [observation] ) );

    expect( getCachedObservation( "obs-0" ) ).toBeUndefined( );
    expect(
      getCachedObservation( `obs-${MAX_CACHED_OBSERVATIONS}` ).value,
    ).toEqual( { uuid: `obs-${MAX_CACHED_OBSERVATIONS}` } );
  } );

  it( "forgets everything when the cache is cleared", ( ) => {
    setCachedNotifications( OWNER, makeNotifications( 1 ) );
    setCachedObservations( [{ uuid: "obs-uuid" }] );

    clearNotificationsCache( );

    expect( getCachedNotifications( OWNER ) ).toBeUndefined( );
    expect( getCachedObservation( "obs-uuid" ) ).toBeUndefined( );
  } );
} );
