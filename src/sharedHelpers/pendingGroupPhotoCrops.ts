// Crops confirmed in the bulk cropper write their files in the background so
// tapping the checkmark can advance to the next photo immediately. Each
// background job updates the grouped-photos store when it lands, so anything
// that consumes those photos (importing them as observations) has to wait for
// the outstanding jobs first.
const pendingCrops = new Set<Promise<unknown>>( );

export function trackGroupPhotoCrop( promise: Promise<unknown> ): void {
  pendingCrops.add( promise );
  promise
    .catch( ( ) => null )
    .finally( ( ) => {
      pendingCrops.delete( promise );
    } );
}

export async function awaitPendingGroupPhotoCrops( ): Promise<void> {
  while ( pendingCrops.size > 0 ) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.allSettled( [...pendingCrops] );
  }
}
