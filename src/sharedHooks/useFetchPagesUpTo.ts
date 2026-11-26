import { useEffect, useRef } from "react";

interface Options {
  enabled: boolean;
  loadedCount: number;
  limit: number;
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  fetchNextPage: ( ) => unknown;
}

// Keeps fetching pages of an infinite query until `limit` results have loaded, for lists that
// have to be sorted on device, like taxonomic order. Stops when a page adds nothing (e.g. it
// failed), so an error doesn't turn into a request loop; loading more resumes it.
const useFetchPagesUpTo = ( {
  enabled, loadedCount, limit, hasNextPage, isFetchingNextPage, fetchNextPage,
}: Options ) => {
  const requestedAtRef = useRef<number | null>( null );
  useEffect( ( ) => {
    if ( !enabled ) {
      requestedAtRef.current = null;
      return;
    }
    if ( !hasNextPage || isFetchingNextPage || loadedCount >= limit ) return;
    if ( requestedAtRef.current === loadedCount ) return;
    requestedAtRef.current = loadedCount;
    fetchNextPage( );
  }, [enabled, loadedCount, limit, hasNextPage, isFetchingNextPage, fetchNextPage] );
};

export default useFetchPagesUpTo;
