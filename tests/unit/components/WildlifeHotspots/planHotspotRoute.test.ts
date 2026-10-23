import planHotspotRoute from "components/WildlifeHotspots/planHotspotRoute";

type Point = [number, number];

const matrixFor = ( points: Point[] ) => points.map( ( [ax, ay] ) => points.map(
  ( [bx, by] ) => Math.hypot( ax - bx, ay - by ),
) );

// Best score over every ordering of every subset of candidates
const bruteForceScore = (
  durations: number[][],
  fixedCount: number,
  scores: number[],
  limit: number,
) => {
  let best = 0;
  const visit = ( seq: number[], used: Set<number>, score: number, cost: number ) => {
    const last = seq[seq.length - 1];
    if ( cost + durations[last][fixedCount - 1] <= limit ) best = Math.max( best, score );
    scores.forEach( ( s, i ) => {
      const node = fixedCount + i;
      if ( used.has( node ) ) return;
      used.add( node );
      visit( [...seq, node], used, score + s, cost + durations[last][node] );
      used.delete( node );
    } );
  };
  visit( [0], new Set(), 0, 0 );
  return best;
};

describe( "planHotspotRoute", () => {
  const points: Point[] = [[0, 0], [10, 0], [5, 1], [5, 3], [2, 1], [8, 1]];
  const durations = matrixFor( points );
  const scores = [5, 8, 3, 3];

  it( "returns null when the route alone exceeds the limit", () => {
    expect( planHotspotRoute( durations, 2, scores, 9 ) ).toBeNull( );
  } );

  it( "adds nothing when no hotspot fits", () => {
    expect( planHotspotRoute( durations, 2, scores, 10 ) ).toEqual( {
      sequence: [0, 1], durationSec: 10, score: 0,
    } );
  } );

  it( "keeps fixed stops in order and stays within the limit", () => {
    const plan = planHotspotRoute( durations, 2, scores, 12 );
    expect( plan?.sequence[0] ).toBe( 0 );
    expect( plan?.sequence[plan.sequence.length - 1] ).toBe( 1 );
    expect( plan?.durationSec ).toBeLessThanOrEqual( 12 );
    expect( plan?.score ).toBe( bruteForceScore( durations, 2, scores, 12 ) );
  } );

  it( "matches the optimum on random instances", () => {
    let seed = 1;
    const random = ( ) => {
      seed = ( seed * 16807 ) % 2147483647;
      return seed / 2147483647;
    };
    for ( let n = 0; n < 30; n += 1 ) {
      const candidates: Point[] = Array.from(
        { length: 6 },
        ( ) => [random( ) * 10, random( ) * 4 - 2],
      );
      const instance = matrixFor( [[0, 0], [10, 0], ...candidates] );
      const instanceScores = candidates.map( ( ) => Math.ceil( random( ) * 10 ) );
      const limit = 10 + random( ) * 8;
      const plan = planHotspotRoute( instance, 2, instanceScores, limit );
      expect( plan?.durationSec ).toBeLessThanOrEqual( limit );
      expect( plan?.score ).toBe( bruteForceScore( instance, 2, instanceScores, limit ) );
    }
  } );
} );
