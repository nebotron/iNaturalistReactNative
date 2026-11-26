import {
  getUserCreatedAt,
  isNewCommunityMember,
  NEW_COMMUNITY_MEMBER_DAYS,
} from "sharedHelpers/isNewCommunityMember";

describe( "isNewCommunityMember", ( ) => {
  const now = new Date( "2026-05-24T12:00:00.000Z" ).getTime( );

  test( "should return true when user joined within the last 30 days", ( ) => {
    const user = { created_at: "2026-05-10T12:00:00.000Z" };

    expect( isNewCommunityMember( user, now ) ).toBe( true );
  } );

  test( "should return false when user joined more than 30 days ago", ( ) => {
    const user = { created_at: "2026-04-01T12:00:00.000Z" };

    expect( isNewCommunityMember( user, now ) ).toBe( false );
  } );

  test( "should return true on the 30th day after joining", ( ) => {
    const joinedAt = new Date( now - NEW_COMMUNITY_MEMBER_DAYS * 24 * 60 * 60 * 1000 );
    const user = { created_at: joinedAt.toISOString( ) };

    expect( isNewCommunityMember( user, now ) ).toBe( true );
  } );

  test( "should support camelCase createdAt", ( ) => {
    const user = { createdAt: "2026-05-20T12:00:00.000Z" };

    expect( isNewCommunityMember( user, now ) ).toBe( true );
  } );

  test( "should return false when join date is missing or invalid", ( ) => {
    expect( isNewCommunityMember( null, now ) ).toBe( false );
    expect( isNewCommunityMember( {}, now ) ).toBe( false );
    expect( isNewCommunityMember( { created_at: "not-a-date" }, now ) ).toBe( false );
  } );

  test( "getUserCreatedAt should prefer snake_case", ( ) => {
    expect( getUserCreatedAt( {
      created_at: "2026-05-01T00:00:00.000Z",
      createdAt: "2026-04-01T00:00:00.000Z",
    } ) ).toBe( "2026-05-01T00:00:00.000Z" );
  } );
} );
