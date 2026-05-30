const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  mapper: ( item: T, index: number ) => Promise<R>,
): Promise<R[]> => {
  if ( items.length === 0 ) {
    return [];
  }

  const results: R[] = new Array( items.length );
  let nextIndex = 0;
  const workerCount = Math.min( Math.max( 1, concurrency ), items.length );

  await Promise.all(
    Array.from( { length: workerCount }, async ( ) => {
      while ( nextIndex < items.length ) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper( items[currentIndex], currentIndex );
      }
    } ),
  );

  return results;
};

export default mapWithConcurrency;
