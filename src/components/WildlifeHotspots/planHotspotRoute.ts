// Picks which hotspots to visit, and where, so the route's driving time stays
// within a limit while the summed hotspot scores are as high as possible (the
// orienteering problem). Nodes 0..fixedCount-1 are the user's stops, visited in
// that order; node fixedCount + i is candidate i, worth scores[i].
// durations[a][b] is the driving time in seconds from node a to node b.

export interface HotspotRoutePlan {
  // Node indices in visiting order, fixed stops included
  sequence: number[];
  durationSec: number;
  score: number;
}

type Weight = ( score: number, addedSec: number ) => number;

// Different trade-offs between value and time, each a separate greedy start
const WEIGHTS: Weight[] = [
  ( s, a ) => s / Math.max( a, 1 ),
  ( s, a ) => ( s * s ) / Math.max( a, 1 ),
  ( s, a ) => s / Math.max( a, 1 ) ** 2,
  s => s,
];

export default function planHotspotRoute(
  durations: number[][],
  fixedCount: number,
  scores: number[],
  limitSec: number,
): HotspotRoutePlan | null {
  const cost = ( a: number, b: number ) => durations[a]?.[b] ?? Infinity;
  const routeCost = ( seq: number[] ) => seq.slice( 1 )
    .reduce( ( sum, node, i ) => sum + cost( seq[i], node ), 0 );
  const scoreOf = ( seq: number[] ) => seq
    .reduce( ( sum, node ) => sum + ( node >= fixedCount
      ? scores[node - fixedCount]
      : 0 ), 0 );

  const base = Array.from( { length: fixedCount }, ( _, i ) => i );
  if ( routeCost( base ) > limitSec ) return null;

  // Repeatedly inserts the unvisited candidate with the best weight at its
  // cheapest position, until none fits within the limit
  const fill = ( start: number[], weight: Weight, excluded?: number ) => {
    const seq = [...start];
    let total = routeCost( seq );
    for ( ;; ) {
      const visited = new Set( seq );
      let best: { node: number; pos: number; added: number; w: number } | null = null;
      for ( let i = 0; i < scores.length; i += 1 ) {
        const node = fixedCount + i;
        const score = scores[i];
        const eligible = !visited.has( node ) && node !== excluded && score > 0;
        for ( let pos = 1; eligible && pos < seq.length; pos += 1 ) {
          const added = cost( seq[pos - 1], node ) + cost( node, seq[pos] )
            - cost( seq[pos - 1], seq[pos] );
          if ( total + added <= limitSec ) {
            const w = weight( score, added );
            if ( !best || w > best.w || ( w === best.w && added < best.added ) ) {
              best = {
                node, pos, added, w,
              };
            }
          }
        }
      }
      if ( !best ) return seq;
      const { node, pos, added } = best;
      seq.splice( pos, 0, node );
      total += added;
    }
  };

  // Reverses runs of hotspots between the same pair of fixed stops when that
  // shortens the route, freeing time for more hotspots
  const twoOpt = ( start: number[] ) => {
    let seq = start;
    let total = routeCost( seq );
    let improved = true;
    while ( improved ) {
      improved = false;
      for ( let i = 1; i < seq.length - 1; i += 1 ) {
        for ( let j = i + 1; j < seq.length - 1 && seq[j] >= fixedCount; j += 1 ) {
          if ( seq[i] < fixedCount ) break;
          const next = [
            ...seq.slice( 0, i ),
            ...seq.slice( i, j + 1 ).reverse( ),
            ...seq.slice( j + 1 ),
          ];
          const nextTotal = routeCost( next );
          if ( nextTotal < total - 1e-6 ) {
            seq = next;
            total = nextTotal;
            improved = true;
          }
        }
      }
    }
    return seq;
  };

  const isBetter = ( a: number[], b: number[] ) => {
    const sa = scoreOf( a );
    const sb = scoreOf( b );
    return sa > sb || ( sa === sb && routeCost( a ) < routeCost( b ) - 1e-6 );
  };

  let best = base;
  WEIGHTS.forEach( weight => {
    let seq = fill( twoOpt( fill( base, weight ) ), weight );
    // Dropping one hotspot can make room for others worth more in total
    let improved = true;
    while ( improved ) {
      improved = false;
      for ( let k = 0; k < seq.length && !improved; k += 1 ) {
        const removed = seq[k];
        if ( removed >= fixedCount ) {
          const without = seq.filter( node => node !== removed );
          const next = fill( twoOpt( fill( without, weight, removed ) ), weight );
          if ( isBetter( next, seq ) ) {
            seq = next;
            improved = true;
          }
        }
      }
    }
    if ( isBetter( seq, best ) ) best = seq;
  } );

  return { sequence: best, durationSec: routeCost( best ), score: scoreOf( best ) };
}
