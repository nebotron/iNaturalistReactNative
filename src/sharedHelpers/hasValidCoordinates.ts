interface Coordinates {
  latitude?: number | null;
  longitude?: number | null;
}

const hasValidCoordinates = ( { latitude, longitude }: Coordinates ): boolean => (
  !!(
    latitude
    && longitude
    && latitude !== 0
    && longitude !== 0
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180
  )
);

export default hasValidCoordinates;
