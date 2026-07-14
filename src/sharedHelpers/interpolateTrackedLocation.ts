// Interpolation phase for tracked-location geotagging.
//
// The location history tracker stores every raw GPS fix it receives (no
// thinning at capture time), so the responsibility for discarding unreliable
// fixes lives here, when we interpolate a location for a given timestamp.

// A tracked fix is only used for a given photo when the nearest fix in time is
// within this many milliseconds of the photo. Kept moderate so a stationary
// user (who generates no new fixes until they move past distanceFilter) still
// matches, while a stale fix from hours earlier - when the user may have
// travelled kilometers - is rejected rather than tagged onto the photo.
export const MAX_MATCH_GAP_MS = 60 * 60 * 1000;

// Straight-line interpolation between two bracketing fixes is only trustworthy
// when they're close together in time. Across a longer gap the real path is
// unknown, so a linear midpoint can land kilometers off route; beyond this span
// we snap to the temporally nearest fix instead of interpolating.
export const MAX_INTERPOLATION_SPAN_MS = 5 * 60 * 1000;

// A fix whose reported accuracy radius (in meters) is worse than this is
// treated as unreliable and filtered out before interpolating, as long as
// better fixes remain. This keeps a noisy outlier from dragging an
// interpolated location off course.
export const MAX_USABLE_ACCURACY_M = 100;

export interface TrackedPoint {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  recordedAt: Date;
}

export interface InterpolatedLocation {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

const toLocation = ( point: TrackedPoint ): InterpolatedLocation => ( {
  latitude: point.latitude,
  longitude: point.longitude,
  accuracy: point.accuracy ?? null,
} );

const hasUsableAccuracy = ( point: TrackedPoint ): boolean => (
  typeof point.accuracy === "number"
  && point.accuracy > 0
  && point.accuracy <= MAX_USABLE_ACCURACY_M
);

// Drops unreliable fixes so they can't corrupt interpolation. Falls back to
// the full set when nothing clears the bar, so we still return a best-effort
// match rather than nothing. Input order (sorted by recordedAt) is preserved.
const filterByAccuracy = ( points: ArrayLike<TrackedPoint> ): TrackedPoint[] => {
  const all = Array.from( points );
  const usable = all.filter( hasUsableAccuracy );
  return usable.length > 0
    ? usable
    : all;
};

// Finds the first index whose recordedAt is >= targetMs (or points.length if none)
const upperBound = ( points: ArrayLike<TrackedPoint>, targetMs: number ): number => {
  let lo = 0;
  let hi = points.length;
  while ( lo < hi ) {
    const mid = Math.floor( ( lo + hi ) / 2 );
    if ( points[mid].recordedAt.getTime() < targetMs ) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
};

// Drops unreliable fixes once, up front. Callers interpolating for many
// timestamps against the same point set (e.g. one per observation) should
// filter once with this and reuse the result via interpolateFromUsablePoints,
// rather than re-filtering the full point set on every call.
export const filterUsableTrackedPoints = (
  rawPoints: ArrayLike<TrackedPoint>,
): TrackedPoint[] => filterByAccuracy( rawPoints );

// Linearly interpolates between the two tracked points bracketing targetMs,
// falling back to the single closest point when targetMs is outside the
// tracked range entirely. `points` must already be accuracy-filtered (see
// filterUsableTrackedPoints) and sorted by recordedAt.
export const interpolateFromUsablePoints = (
  points: TrackedPoint[],
  targetMs: number,
): InterpolatedLocation | null => {
  if ( points.length === 0 ) return null;

  const idx = upperBound( points, targetMs );
  const next = idx < points.length
    ? points[idx]
    : null;
  const prev = idx > 0
    ? points[idx - 1]
    : null;

  if ( !prev && !next ) return null;

  if ( !prev ) {
    const gap = ( next as TrackedPoint ).recordedAt.getTime() - targetMs;
    return gap <= MAX_MATCH_GAP_MS
      ? toLocation( next as TrackedPoint )
      : null;
  }

  if ( !next ) {
    const gap = targetMs - prev.recordedAt.getTime();
    return gap <= MAX_MATCH_GAP_MS
      ? toLocation( prev )
      : null;
  }

  const prevMs = prev.recordedAt.getTime();
  const nextMs = next.recordedAt.getTime();

  const gapToPrev = targetMs - prevMs;
  const gapToNext = nextMs - targetMs;
  const minGap = Math.min( gapToPrev, gapToNext );
  if ( minGap > MAX_MATCH_GAP_MS ) return null;

  // When the bracketing fixes are far apart in time, don't invent a straight-
  // line midpoint - snap to whichever fix is closest to the photo's time.
  if ( nextMs - prevMs > MAX_INTERPOLATION_SPAN_MS ) {
    return toLocation( gapToPrev <= gapToNext
      ? prev
      : next );
  }

  if ( prevMs === targetMs ) return toLocation( prev );

  const weight = ( targetMs - prevMs ) / ( nextMs - prevMs );
  return {
    latitude: prev.latitude + weight * ( next.latitude - prev.latitude ),
    longitude: prev.longitude + weight * ( next.longitude - prev.longitude ),
    accuracy: Math.max( prev.accuracy ?? 0, next.accuracy ?? 0 ) || null,
  };
};

// Convenience one-shot wrapper for callers interpolating a single timestamp.
// Prefer filterUsableTrackedPoints + interpolateFromUsablePoints when calling
// repeatedly against the same point set.
export const findInterpolatedLocation = (
  rawPoints: ArrayLike<TrackedPoint>,
  targetMs: number,
): InterpolatedLocation | null => interpolateFromUsablePoints(
  filterUsableTrackedPoints( rawPoints ),
  targetMs,
);

export default findInterpolatedLocation;
