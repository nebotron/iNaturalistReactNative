// An AbortController scoped to a single upload attempt.
//
// One upload's timeout aborts only that upload, not every concurrent one. It's
// linked to the session controller so cancelling the batch still reaches it.
//
// `release` must run when the attempt settles, however it settles, or the
// timer fires later at whatever is running by then (the session controller
// survives across batches).
const createUploadAbortController = (
  sessionSignal: AbortSignal | undefined,
  timeoutMs: number,
  onTimeout: ( ) => void,
): { signal: AbortSignal; release: ( ) => void } => {
  const controller = new AbortController( );

  const timeoutID = setTimeout( ( ) => {
    onTimeout( );
    controller.abort( );
  }, timeoutMs );

  let unsubscribe: ( ) => void = ( ) => {};
  if ( sessionSignal?.aborted ) {
    controller.abort( );
  } else if ( sessionSignal ) {
    const onSessionAbort = ( ) => controller.abort( );
    sessionSignal.addEventListener( "abort", onSessionAbort );
    unsubscribe = ( ) => sessionSignal.removeEventListener( "abort", onSessionAbort );
  }

  return {
    signal: controller.signal,
    release: ( ) => {
      clearTimeout( timeoutID );
      unsubscribe( );
    },
  };
};

export default createUploadAbortController;
