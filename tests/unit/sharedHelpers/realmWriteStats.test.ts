import type * as Stats from "sharedHelpers/realmWriteStats";
import type SafeRealmWrite from "sharedHelpers/safeRealmWrite";

const mockInfoWithExtra = jest.fn( );
jest.mock( "sharedHelpers/logger", ( ) => ( {
  log: {
    extend: ( ) => ( {
      infoWithExtra: ( ...args: unknown[] ) => mockInfoWithExtra( ...args ),
    } ),
  },
} ) );

const fakeRealm = ( ) => ( {
  isInTransaction: false,
  beginTransaction: jest.fn( ),
  commitTransaction: jest.fn( ),
  cancelTransaction: jest.fn( ),
} );

// The test setup loads Realm models, and with them these modules, before this
// file's logger mock applies, so load fresh copies that see it
let flushRealmWriteStats: typeof Stats.flushRealmWriteStats;
let recordRealmWrite: typeof Stats.recordRealmWrite;
let safeRealmWrite: typeof SafeRealmWrite;

describe( "realmWriteStats", ( ) => {
  beforeEach( ( ) => {
    jest.isolateModules( ( ) => {
      ( { flushRealmWriteStats, recordRealmWrite } = jest.requireActual<typeof Stats>(
        "sharedHelpers/realmWriteStats",
      ) );
      safeRealmWrite = jest.requireActual( "sharedHelpers/safeRealmWrite" ).default;
    } );
    flushRealmWriteStats( );
    mockInfoWithExtra.mockClear( );
  } );

  it( "tallies safeRealmWrite commits by description", ( ) => {
    const realm = fakeRealm( );
    safeRealmWrite( realm as never, ( ) => null, "saving taxa" );
    safeRealmWrite( realm as never, ( ) => null, "saving taxa" );
    safeRealmWrite( realm as never, ( ) => null, "saving photo" );
    flushRealmWriteStats( );

    expect( mockInfoWithExtra ).toHaveBeenCalledTimes( 1 );
    const [message, extra] = mockInfoWithExtra.mock.calls[0];
    expect( message ).toBe( "realm_write_summary" );
    expect( extra.commits ).toBe( 3 );
    const byLabel = JSON.parse( extra.byLabel );
    expect( byLabel["saving taxa"].n ).toBe( 2 );
    expect( byLabel["saving photo"].n ).toBe( 1 );
  } );

  it( "doesn't count a write nested in an open transaction", ( ) => {
    const realm = { ...fakeRealm( ), isInTransaction: true };
    safeRealmWrite( realm as never, ( ) => null, "nested" );
    flushRealmWriteStats( );
    expect( mockInfoWithExtra ).not.toHaveBeenCalled( );
  } );

  it( "logs on its own once the interval has passed, then starts over", ( ) => {
    const start = Date.now( );
    flushRealmWriteStats( start );
    recordRealmWrite( "a", 5, start + 1000 );
    expect( mockInfoWithExtra ).not.toHaveBeenCalled( );
    recordRealmWrite( "a", 7, start + 11 * 60 * 1000 );
    expect( mockInfoWithExtra ).toHaveBeenCalledTimes( 1 );
    expect( JSON.parse( mockInfoWithExtra.mock.calls[0][1].byLabel ).a ).toEqual(
      { n: 2, ms: 12, maxMs: 7 },
    );
    flushRealmWriteStats( );
    expect( mockInfoWithExtra ).toHaveBeenCalledTimes( 1 );
  } );
} );
