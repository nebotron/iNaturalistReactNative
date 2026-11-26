import mapWithConcurrency from "sharedHelpers/mapWithConcurrency";

const deferred = ( ) => {
  let resolve: ( value: string ) => void = ( ) => undefined;
  const promise = new Promise<string>( r => {
    resolve = r;
  } );
  return { promise, resolve };
};

const flush = ( ) => new Promise( resolve => { setImmediate( resolve ); } );

describe( "mapWithConcurrency", ( ) => {
  it( "returns results in the order of the items, not the order they settled", async ( ) => {
    const results = await mapWithConcurrency(
      ["slow", "fast"],
      2,
      async ( item: string ) => {
        if ( item === "slow" ) {
          await flush( );
          await flush( );
        }
        return item.toUpperCase( );
      },
    );
    expect( results ).toEqual( ["SLOW", "FAST"] );
  } );

  it( "never runs more than the limit at once", async ( ) => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency( [1, 2, 3, 4, 5, 6, 7], 3, async ( item: number ) => {
      running += 1;
      peak = Math.max( peak, running );
      await flush( );
      running -= 1;
      return item;
    } );
    expect( peak ).toEqual( 3 );
  } );

  it( "starts the next item as soon as a slot frees rather than waiting for a batch", async ( ) => {
    const blocker = deferred( );
    const started: number[] = [];
    const work = mapWithConcurrency( [0, 1, 2, 3], 2, async ( item: number ) => {
      started.push( item );
      // The first item hangs, the way an iCloud-offloaded photo does.
      if ( item === 0 ) return blocker.promise;
      return String( item );
    } );

    await flush( );
    // The one free slot works through everything else while item 0 hangs, so a
    // straggler no longer holds up the items queued behind it.
    expect( started ).toEqual( [0, 1, 2, 3] );

    blocker.resolve( "0" );
    await expect( work ).resolves.toEqual( ["0", "1", "2", "3"] );
  } );

  it( "handles an empty list", async ( ) => {
    await expect( mapWithConcurrency( [], 4, async ( ) => "x" ) ).resolves.toEqual( [] );
  } );
} );
