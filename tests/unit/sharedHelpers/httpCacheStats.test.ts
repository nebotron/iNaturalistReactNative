import type * as Stats from "sharedHelpers/httpCacheStats";

const mockInfoWithExtra = jest.fn( );
jest.mock( "sharedHelpers/logger", ( ) => ( {
  log: {
    extend: ( ) => ( {
      infoWithExtra: ( ...args: unknown[] ) => mockInfoWithExtra( ...args ),
    } ),
  },
} ) );

const mockTally = ( n = 0 ) => ( {
  n, chars: n * 100, ms: n, maxMs: n,
} );
const mockStats = {
  native: true, read: mockTally( ), write: mockTally( ), failures: 0,
};
const mockTake = jest.fn( ( ) => ( { ...mockStats } ) );
let mockListener: ( ( ) => void ) | undefined;
jest.mock( "sharedHelpers/httpCache", ( ) => ( {
  takeHttpCacheStats: ( ) => mockTake( ),
  setHttpCacheStatsListener: ( listener: ( ) => void ) => { mockListener = listener; },
} ) );

let flushHttpCacheStats: typeof Stats.flushHttpCacheStats;
let startHttpCacheStats: typeof Stats.startHttpCacheStats;

describe( "httpCacheStats", ( ) => {
  beforeEach( ( ) => {
    jest.isolateModules( ( ) => {
      ( { flushHttpCacheStats, startHttpCacheStats } = jest.requireActual<typeof Stats>(
        "sharedHelpers/httpCacheStats",
      ) );
    } );
    mockInfoWithExtra.mockClear( );
    mockTake.mockClear( );
  } );

  it( "logs one summary of the cache's reads and writes", ( ) => {
    mockTake.mockReturnValueOnce( { ...mockStats, read: mockTally( 3 ), write: mockTally( 2 ) } );
    flushHttpCacheStats( );
    expect( mockInfoWithExtra ).toHaveBeenCalledWith(
      "http_cache_summary",
      expect.objectContaining( {
        read: mockTally( 3 ), write: mockTally( 2 ), native: true,
      } ),
    );
  } );

  it( "logs nothing when the cache did nothing", ( ) => {
    flushHttpCacheStats( );
    expect( mockTake ).toHaveBeenCalledTimes( 1 );
    expect( mockInfoWithExtra ).not.toHaveBeenCalled( );
  } );

  it( "logs from the listener only once the interval has passed", ( ) => {
    const now = jest.spyOn( Date, "now" ).mockReturnValue( 1_000_000 );
    startHttpCacheStats( );
    mockTake.mockReturnValue( { ...mockStats, write: mockTally( 1 ) } );

    now.mockReturnValue( 1_000_000 + 60_000 );
    mockListener?.( );
    expect( mockInfoWithExtra ).not.toHaveBeenCalled( );

    now.mockReturnValue( 1_000_000 + 10 * 60 * 1000 );
    mockListener?.( );
    expect( mockInfoWithExtra ).toHaveBeenCalledTimes( 1 );
    expect( mockInfoWithExtra.mock.calls[0][1] ).toMatchObject( {
      windowSec: 600, write: { n: 1 },
    } );
    now.mockRestore( );
    mockTake.mockReset( );
    mockTake.mockImplementation( ( ) => ( { ...mockStats } ) );
  } );
} );
