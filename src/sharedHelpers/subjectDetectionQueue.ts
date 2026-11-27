import { getTunable } from "sharedHelpers/tunableParams";

// Subject detection downloads the original photo, decodes it and runs the
// detector on it. Identify started one for every upcoming photo at once, and
// the Nov 26 kill climbed ~1.4 GB in 30 s while swiping through them, so at
// most this many run at a time and the rest wait their turn.
const MAX_CONCURRENT = getTunable( "subjectDetectionConcurrency" );

interface Job {
  run: ( ) => void;
  key?: string;
}

let running = 0;
// The photo on screen goes ahead of those only being prepared in advance,
// which can pile up behind it when the user swipes quickly
const urgent: Job[] = [];
const ahead: Job[] = [];

const runNext = ( ) => {
  while ( running < MAX_CONCURRENT ) {
    const job = urgent.shift( ) ?? ahead.shift( );
    if ( !job ) return;
    running += 1;
    job.run( );
  }
};

// `key` lets a job queued in advance be moved ahead once its photo is on screen
const queueSubjectDetection = <T>(
  work: ( ) => Promise<T>,
  { inAdvance = false, key }: { inAdvance?: boolean; key?: string } = {},
): Promise<T> => new Promise<T>( ( resolve, reject ) => {
  const run = ( ) => {
    work( )
      .then( resolve, reject )
      .finally( ( ) => {
        running -= 1;
        runNext( );
      } );
  };
  ( inAdvance
    ? ahead
    : urgent ).push( { run, key } );
  runNext( );
} );

// The photo a job was queued in advance for is now on screen
export const prioritizeSubjectDetection = ( key: string ) => {
  const index = ahead.findIndex( job => job.key === key );
  if ( index < 0 ) return;
  urgent.push( ...ahead.splice( index, 1 ) );
  runNext( );
};

export default queueSubjectDetection;
