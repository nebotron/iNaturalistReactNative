// An AbortController scoped to a single upload attempt.
//
// Every concurrent upload used to share the session's one controller, so any
// observation reaching its timeout aborted every other upload in flight,
// however young: in the Aug 5 19:08-20:22 log one timeout at 19:51:36 took a
// sibling down 9.2s short of its own deadline, and the abort at 20:08:35
// killed an upload 24s old. The session controller still has to reach every
// upload when the user cancels the batch, hence the link rather than a plain
// new controller.
//
// `release` must run when the attempt settles, however it settles. The old
// code cleared its timeout only on success — the clearTimeout sat after the
// await inside the try — so a failed upload left a live timer that fired five
// minutes later at whatever was running by then, and because
// resetUploadObservationsSlice and stopAllUploads both preserve the session
// controller, that reached across batches.
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
