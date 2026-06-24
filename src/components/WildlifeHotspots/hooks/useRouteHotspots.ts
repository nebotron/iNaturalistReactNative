import {
  fetchSpeciesCounts,
  searchObservations,
} from "api/observations";
import { useCallback, useState } from "react";

export interface RoutePoint {
  latitude: number;
  longitude: number;
}

export interface HotspotSpecies {
  id: number;
  name: string;
  preferred_common_name?: string;
  count: number;
}

export interface Hotspot {
  id: string;
  centerLatitude: number;
  centerLongitude: number;
  observationCount: number;
  detourKm: number;
  topSpecies: HotspotSpecies[];
}

const EARTH_RADIUS_KM = 6371;
const HOTSPOT_RADIUS_KM = 25;

function toRad( deg: number ): number {
  return ( deg * Math.PI ) / 180;
}

function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRad( lat2 - lat1 );
  const dLon = toRad( lon2 - lon1 );
  const a =
    Math.sin( dLat / 2 ) ** 2
    + Math.cos( toRad( lat1 ) ) * Math.cos( toRad( lat2 ) ) * Math.sin( dLon / 2 ) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin( Math.sqrt( a ) );
}

function sampleRoutePoints(
  start: RoutePoint,
  end: RoutePoint,
  count: number,
): RoutePoint[] {
  const points: RoutePoint[] = [];
  for ( let i = 0; i < count; i++ ) {
    const t = count === 1 ? 0 : i / ( count - 1 );
    points.push( {
      latitude: start.latitude + t * ( end.latitude - start.latitude ),
      longitude: start.longitude + t * ( end.longitude - start.longitude ),
    } );
  }
  return points;
}

// Distance from a point to the nearest point on the line segment (start→end)
function distanceToRouteLine(
  point: RoutePoint,
  routeStart: RoutePoint,
  routeEnd: RoutePoint,
): number {
  const dx = routeEnd.longitude - routeStart.longitude;
  const dy = routeEnd.latitude - routeStart.latitude;
  const len2 = dx * dx + dy * dy;
  if ( len2 === 0 ) {
    return haversineDistance(
      point.latitude,
      point.longitude,
      routeStart.latitude,
      routeStart.longitude,
    );
  }
  const t = Math.max(
    0,
    Math.min(
      1,
      ( ( point.longitude - routeStart.longitude ) * dx
        + ( point.latitude - routeStart.latitude ) * dy )
        / len2,
    ),
  );
  const nearestLat = routeStart.latitude + t * dy;
  const nearestLng = routeStart.longitude + t * dx;
  return haversineDistance( point.latitude, point.longitude, nearestLat, nearestLng );
}

export function useRouteHotspots() {
  const [hotspots, setHotspots] = useState<Hotspot[]>( [] );
  const [loading, setLoading] = useState( false );
  const [error, setError] = useState<string | null>( null );

  const findHotspots = useCallback(
    async (
      start: RoutePoint,
      end: RoutePoint,
      filterParams: Record<string, unknown>,
    ) => {
      setLoading( true );
      setError( null );
      setHotspots( [] );

      try {
        const totalDistanceKm = haversineDistance(
          start.latitude,
          start.longitude,
          end.latitude,
          end.longitude,
        );
        // Scale sample count to route length; every ~30km, min 5, max 20
        const numSamples = Math.max( 5, Math.min( 20, Math.round( totalDistanceKm / 30 ) + 1 ) );
        const samplePoints = sampleRoutePoints( start, end, numSamples );

        const countResults = await Promise.all(
          samplePoints.map( async point => {
            const response = await searchObservations( {
              lat: point.latitude,
              lng: point.longitude,
              radius: HOTSPOT_RADIUS_KM,
              per_page: 0,
              verifiable: true,
              ...filterParams,
            } );
            return {
              point,
              count: response?.total_results ?? 0,
              bounds: response?.total_bounds ?? null,
            };
          } ),
        );

        // Take the top 10 by count for species lookup
        const ranked = countResults
          .filter( r => r.count > 0 )
          .sort( ( a, b ) => b.count - a.count )
          .slice( 0, 10 );

        const results = await Promise.all(
          ranked.map( async ( result, idx ) => {
            const speciesResponse = await fetchSpeciesCounts( {
              lat: result.point.latitude,
              lng: result.point.longitude,
              radius: HOTSPOT_RADIUS_KM,
              per_page: 5,
              verifiable: true,
              ...filterParams,
            } );

            const topSpecies: HotspotSpecies[] = ( speciesResponse?.results ?? [] )
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map( ( entry: any ) => ( {
                id: entry.taxon?.id,
                name: entry.taxon?.name ?? "",
                preferred_common_name: entry.taxon?.preferred_common_name,
                count: entry.count,
              } ) );

            // If the API returns bounds, use their center as a more accurate
            // hotspot location; otherwise fall back to the sample point
            let centerLat = result.point.latitude;
            let centerLng = result.point.longitude;
            if ( result.bounds ) {
              centerLat = ( result.bounds.swlat + result.bounds.nelat ) / 2;
              centerLng = ( result.bounds.swlng + result.bounds.nelng ) / 2;
            }

            const detourKm = distanceToRouteLine(
              { latitude: centerLat, longitude: centerLng },
              start,
              end,
            );

            return {
              id: `hotspot-${idx}-${result.point.latitude.toFixed( 4 )}-${result.point.longitude.toFixed( 4 )}`,
              centerLatitude: centerLat,
              centerLongitude: centerLng,
              observationCount: result.count,
              detourKm,
              topSpecies,
            };
          } ),
        );

        setHotspots( results );
      } catch ( _err ) {
        setError( "Failed to load hotspot data. Please try again." );
      } finally {
        setLoading( false );
      }
    },
    [],
  );

  return {
    hotspots,
    loading,
    error,
    findHotspots,
  };
}
