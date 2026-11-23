// Settles like `promise`, or rejects once `ms` pass without it settling. The
// promise itself keeps running; this only stops the caller waiting on it.
const withTimeout = <T, >( promise: Promise<T>, ms: number, label: string ): Promise<T> => (
  new Promise<T>( ( resolve, reject ) => {
    const timer = setTimeout(
      ( ) => reject( new Error( `${label} timed out after ${ms}ms` ) ),
      ms,
    );
    promise.then(
      value => {
        clearTimeout( timer );
        resolve( value );
      },
      error => {
        clearTimeout( timer );
        reject( error );
      },
    );
  } )
);

// Like withTimeout, but running out of time is a result rather than an error
export const raceTimeout = <T, >(
  promise: Promise<T>,
  ms: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race( [
    promise.then( value => ( { timedOut: false as const, value } ) ),
    new Promise<{ timedOut: true }>( resolve => {
      timer = setTimeout( ( ) => resolve( { timedOut: true } ), ms );
    } ),
  ] ).finally( ( ) => clearTimeout( timer ) );
};

export default withTimeout;
