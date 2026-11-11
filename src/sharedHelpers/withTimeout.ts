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

export default withTimeout;
