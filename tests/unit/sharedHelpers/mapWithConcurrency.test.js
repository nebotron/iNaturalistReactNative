import mapWithConcurrency from "sharedHelpers/mapWithConcurrency";

describe( "mapWithConcurrency", ( ) => {
  it( "maps items with a concurrency limit", async ( ) => {
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async value => {
        inFlight += 1;
        maxInFlight = Math.max( maxInFlight, inFlight );
        await new Promise( resolve => {
          setTimeout( resolve, 10 );
        } );
        inFlight -= 1;
        return value * 2;
      },
    );

    expect( results ).toEqual( [2, 4, 6, 8, 10] );
    expect( maxInFlight ).toBeLessThanOrEqual( 2 );
  } );
} );
