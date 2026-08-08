export const EARTH_RADIUS_KM = 6371;

const EARTH_RADIUS_METERS = EARTH_RADIUS_KM * 1000;

const toRadians = ( degrees: number ) => ( degrees * Math.PI ) / 180;

// Haversine formula: great-circle distance between two lat/lng points, in meters
const distanceInMeters = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number => {
  const dLat = toRadians( lat2 - lat1 );
  const dLon = toRadians( lon2 - lon1 );
  const a = ( Math.sin( dLat / 2 ) ** 2 )
    + ( Math.cos( toRadians( lat1 ) )
      * Math.cos( toRadians( lat2 ) )
      * ( Math.sin( dLon / 2 ) ** 2 ) );
  const c = 2 * Math.atan2( Math.sqrt( a ), Math.sqrt( 1 - a ) );
  return EARTH_RADIUS_METERS * c;
};

export const distanceInKm = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number => distanceInMeters( lat1, lon1, lat2, lon2 ) / 1000;

export default distanceInMeters;
