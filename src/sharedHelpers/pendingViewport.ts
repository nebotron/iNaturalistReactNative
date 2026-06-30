import type { NormalizedCrop } from "./normalizedCropTypes";

// Bridges the two-finger zoom/pan viewport set in the Explore grid's ObsImage
// to the AgreeButton, which lives in a sibling component. Keyed by photo URL so
// recycled grid cells and multi-photo carousels don't cross-contaminate.
const pending = new Map<string, NormalizedCrop>( );

export const setPendingViewport = ( uri: string, crop: NormalizedCrop ): void => {
  pending.set( uri, crop );
};

// Peek at the pending viewport without consuming it, so a follow-up gesture can
// resume zooming/panning from where the previous one left off.
export const getPendingViewport = ( uri: string ): NormalizedCrop | undefined => pending.get( uri );

export const clearPendingViewport = ( uri: string ): void => {
  pending.delete( uri );
};

// Returns the pending viewport for a URI (if the user zoomed/panned it) and
// removes it so it is only ever consumed once.
export const takePendingViewport = ( uri: string ): NormalizedCrop | undefined => {
  const crop = pending.get( uri );
  if ( crop ) pending.delete( uri );
  return crop;
};
