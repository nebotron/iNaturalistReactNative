export const DEFAULT_NEARBY_RADIUS_KM = 100;

export const MIN_NEARBY_RADIUS_KM = 1;

export const MAX_NEARBY_RADIUS_KM = 40000;

export const parseNearbyRadiusKm = ( value: string ): number => {
  const parsed = Number.parseInt( value.replace( /\D/g, "" ), 10 );
  if ( Number.isNaN( parsed ) ) {
    return DEFAULT_NEARBY_RADIUS_KM;
  }
  return Math.min( MAX_NEARBY_RADIUS_KM, Math.max( MIN_NEARBY_RADIUS_KM, parsed ) );
};
