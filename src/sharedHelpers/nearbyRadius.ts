export const DEFAULT_NEARBY_RADIUS_KM = 100;

// Explore v2 searches a much tighter area by default
export const DEFAULT_EXPLORE_V2_NEARBY_RADIUS_KM = 1;

export const MIN_NEARBY_RADIUS_KM = 1;

export const MAX_NEARBY_RADIUS_KM = 40000;

export const parseNearbyRadiusKm = (
  value: string,
  fallback = DEFAULT_NEARBY_RADIUS_KM,
): number => {
  const parsed = Number.parseInt( value.replace( /\D/g, "" ), 10 );
  if ( Number.isNaN( parsed ) ) {
    return fallback;
  }
  return Math.min( MAX_NEARBY_RADIUS_KM, Math.max( MIN_NEARBY_RADIUS_KM, parsed ) );
};
