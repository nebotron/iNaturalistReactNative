import { useCallback, useLayoutEffect, useRef } from "react";

// A function whose identity never changes but which always runs the latest
// `callback`, for handlers handed to memoized list cells: a handler rebuilt
// on every render re-renders every visible cell along with it. Not for use
// during render, which would read the previous render's callback.
const useStableCallback = <Args extends unknown[], Result>(
  callback: ( ...args: Args ) => Result,
): ( ( ...args: Args ) => Result ) => {
  const ref = useRef( callback );
  useLayoutEffect( ( ) => {
    ref.current = callback;
  } );
  return useCallback( ( ...args: Args ) => ref.current( ...args ), [] );
};

export default useStableCallback;
