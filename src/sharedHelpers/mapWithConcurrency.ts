// Maps over items with a fixed number of tasks in flight, refilling each slot
// the moment it frees.
//
// The obvious alternative — awaiting Promise.all over fixed slices — makes
// every slice as slow as its slowest item, so one straggler idles the rest of
// its slice however quickly they would have finished. That is not a rounding
// error where the slow case is slow by seconds: a photo import waiting out an
// iCloud download paid for that download once per slice it landed in.
//
// Results come back in the order of `items`, not the order they settled, so
// callers can keep pairing a result with the input it came from by index.
const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  mapper: ( item: T, index: number ) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>( items.length );
  let nextIndex = 0;
  const worker = async ( ) => {
    for ( ;; ) {
      const index = nextIndex;
      nextIndex += 1;
      if ( index >= items.length ) return;
      // eslint-disable-next-line no-await-in-loop
      results[index] = await mapper( items[index], index );
    }
  };
  await Promise.all( Array.from(
    { length: Math.max( 1, Math.min( limit, items.length ) ) },
    worker,
  ) );
  return results;
};

export default mapWithConcurrency;
