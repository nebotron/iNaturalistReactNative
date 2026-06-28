import { searchObservations } from "api/observations";
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
  detourMinutes: number;
  topSpecies: HotspotSpecies[];
}

const EARTH_RADIUS_KM = 6371;
const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
// ~3 km grid cells for clustering (1° ≈ 111 km)
const GRID_DEG = 0.027;
// Hotspots must be within this distance of the route to be shown
const MAX_ROUTE_DISTANCE_KM = 25;
// Evaluate detour times for this many top-by-obs candidates
const MAX_DETOUR_CANDIDATES = 30;

function toRad( deg: number ): number {
  return ( deg * Math.PI ) / 180;
}

function haversineKm( lat1: number, lon1: number, lat2: number, lon2: number ): number {
  const dLat = toRad( lat2 - lat1 );
  const dLon = toRad( lon2 - lon1 );
  const a = Math.sin( dLat / 2 ) ** 2
    + Math.cos( toRad( lat1 ) ) * Math.cos( toRad( lat2 ) ) * Math.sin( dLon / 2 ) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin( Math.sqrt( a ) );
}

// Minimum distance from a point to a polyline (sequence of segments)
function distanceToPolylineKm( pt: RoutePoint, polyline: RoutePoint[] ): number {
  let minDist = Infinity;
  for ( let i = 0; i < polyline.length - 1; i++ ) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const dx = b.longitude - a.longitude;
    const dy = b.latitude - a.latitude;
    const len2 = dx * dx + dy * dy;
    let nearLat: number;
    let nearLng: number;
    if ( len2 === 0 ) {
      nearLat = a.latitude;
      nearLng = a.longitude;
    } else {
      const t = Math.max( 0, Math.min( 1,
        ( ( pt.longitude - a.longitude ) * dx + ( pt.latitude - a.latitude ) * dy ) / len2,
      ) );
      nearLat = a.latitude + t * dy;
      nearLng = a.longitude + t * dx;
    }
    const d = haversineKm( pt.latitude, pt.longitude, nearLat, nearLng );
    if ( d < minDist ) minDist = d;
  }
  return minDist;
}

async function fetchOSRMRoute( start: RoutePoint, end: RoutePoint ): Promise<{
  coords: RoutePoint[];
  durationSec: number;
}> {
  const url = `${OSRM_BASE}/${start.longitude},${start.latitude};${end.longitude},${end.latitude}?overview=full&geometries=geojson`;
  const response = await fetch( url );
  if ( !response.ok ) {
    throw new Error( `Routing service error: ${response.status}` );
  }
  const data = await response.json();
  if ( !data.routes?.length ) {
    throw new Error( "No route found between these locations" );
  }
  const coords: [number, number][] = data.routes[0].geometry.coordinates;
  return {
    coords: coords.map( ( [lng, lat] ) => ( { latitude: lat, longitude: lng } ) ),
    durationSec: data.routes[0].duration as number,
  };
}

async function fetchOSRMDuration( waypoints: RoutePoint[] ): Promise<number> {
  const wStr = waypoints.map( w => `${w.longitude},${w.latitude}` ).join( ";" );
  const url = `${OSRM_BASE}/${wStr}?overview=false`;
  try {
    const response = await fetch( url );
    if ( !response.ok ) return Infinity;
    const data = await response.json();
    return ( data.routes?.[0]?.duration as number ) ?? Infinity;
  } catch {
    return Infinity;
  }
}

function routeBbox( coords: RoutePoint[], paddingDeg = 0.3 ) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for ( const { latitude, longitude } of coords ) {
    if ( latitude < minLat ) minLat = latitude;
    if ( latitude > maxLat ) maxLat = latitude;
    if ( longitude < minLng ) minLng = longitude;
    if ( longitude > maxLng ) maxLng = longitude;
  }
  return {
    swlat: minLat - paddingDeg,
    swlng: minLng - paddingDeg,
    nelat: maxLat + paddingDeg,
    nelng: maxLng + paddingDeg,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getObsCoords( obs: any ): { lat: number; lng: number } | null {
  const coords = obs?.geojson?.coordinates;
  if ( Array.isArray( coords ) && coords.length >= 2 ) {
    return { lat: coords[1], lng: coords[0] };
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clusterByGrid( observations: any[] ): Map<string, {
  centerLat: number;
  centerLng: number;
  count: number;
  taxa: Map<number, HotspotSpecies>;
}> {
  const cells = new Map<string, {
    centerLat: number;
    centerLng: number;
    count: number;
    taxa: Map<number, HotspotSpecies>;
  }>();

  for ( const obs of observations ) {
    const coords = getObsCoords( obs );
    if ( !coords ) continue;

    const cellLat = ( Math.floor( coords.lat / GRID_DEG ) + 0.5 ) * GRID_DEG;
    const cellLng = ( Math.floor( coords.lng / GRID_DEG ) + 0.5 ) * GRID_DEG;
    const key = `${cellLat.toFixed( 5 )},${cellLng.toFixed( 5 )}`;

    if ( !cells.has( key ) ) {
      cells.set( key, {
        centerLat: cellLat,
        centerLng: cellLng,
        count: 0,
        taxa: new Map(),
      } );
    }
    const cell = cells.get( key )!;
    cell.count++;

    const taxon = obs.taxon;
    if ( taxon?.id ) {
      const prev = cell.taxa.get( taxon.id );
      if ( prev ) {
        prev.count++;
      } else {
        cell.taxa.set( taxon.id, {
          id: taxon.id,
          name: taxon.name ?? "",
          preferred_common_name: taxon.preferred_common_name,
          count: 1,
        } );
      }
    }
  }

  return cells;
}

export function useRouteHotspots() {
  const [hotspots, setHotspots] = useState<Hotspot[]>( [] );
  const [routeCoords, setRouteCoords] = useState<RoutePoint[]>( [] );
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
      setRouteCoords( [] );

      try {
        // 1. Get the actual road route and baseline travel time
        const { coords: routePoints, durationSec: directDurationSec } = await fetchOSRMRoute( start, end );
        setRouteCoords( routePoints );

        // 2. Single iNaturalist call for the whole route bounding box.
        // Strip location and pagination params from filterParams — the hotspot
        // search provides its own bbox and page size, and passing Explore's
        // lat/lng/radius or place_id would intersect with our bbox and return
        // 0 results whenever the Explore location differs from the route area.
        const LOCATION_AND_PAGINATION_PARAMS = [
          "lat", "lng", "radius", "place_id",
          "swlat", "swlng", "nelat", "nelng",
          "per_page", "order_by", "order",
        ];
        const safeFilterParams = Object.fromEntries(
          Object.entries( filterParams ).filter(
            ( [key] ) => !LOCATION_AND_PAGINATION_PARAMS.includes( key ),
          ),
        );
        const bbox = routeBbox( routePoints );
        const response = await searchObservations( {
          ...bbox,
          per_page: 200,
          verifiable: true,
          order_by: "id",
          fields: {
            geojson: true,
            taxon: {
              id: true,
              name: true,
              preferred_common_name: true,
              iconic_taxon_name: true,
            },
          },
          ...safeFilterParams,
        } );

        const observations = response?.results ?? [];

        // 3. Cluster observations into geographic grid cells
        const cells = clusterByGrid( observations );

        // 4. Filter to cells within MAX_ROUTE_DISTANCE_KM, take top candidates by obs count
        const candidates: Array<{
          id: string;
          centerLat: number;
          centerLng: number;
          count: number;
          topSpecies: HotspotSpecies[];
        }> = [];

        cells.forEach( ( cell, key ) => {
          const dist = distanceToPolylineKm(
            { latitude: cell.centerLat, longitude: cell.centerLng },
            routePoints,
          );
          if ( dist > MAX_ROUTE_DISTANCE_KM ) return;

          const topSpecies = [...cell.taxa.values()]
            .sort( ( a, b ) => b.count - a.count )
            .slice( 0, 5 );

          candidates.push( {
            id: `hotspot-${key}`,
            centerLat: cell.centerLat,
            centerLng: cell.centerLng,
            count: cell.count,
            topSpecies,
          } );
        } );

        candidates.sort( ( a, b ) => b.count - a.count );
        const topCandidates = candidates.slice( 0, MAX_DETOUR_CANDIDATES );

        // 5. Compute actual 3-point travel times in parallel (start → hotspot → end)
        const withDetours = await Promise.all(
          topCandidates.map( async candidate => {
            const threePointSec = await fetchOSRMDuration( [
              start,
              { latitude: candidate.centerLat, longitude: candidate.centerLng },
              end,
            ] );
            const detourMinutes = Math.max(
              0,
              Math.round( ( threePointSec - directDurationSec ) / 60 ),
            );
            return {
              id: candidate.id,
              centerLatitude: candidate.centerLat,
              centerLongitude: candidate.centerLng,
              observationCount: candidate.count,
              detourMinutes,
              topSpecies: candidate.topSpecies,
            };
          } ),
        );

        // 6. Rank by ratio of added travel time to observations (lower = better)
        withDetours.sort( ( a, b ) => {
          const ratioA = a.detourMinutes / a.observationCount;
          const ratioB = b.detourMinutes / b.observationCount;
          return ratioA - ratioB;
        } );

        setHotspots( withDetours.slice( 0, 10 ) );
      } catch ( err ) {
        setError( err instanceof Error ? err.message : "Failed to load hotspot data" );
      } finally {
        setLoading( false );
      }
    },
    [],
  );

  return {
    hotspots,
    routeCoords,
    loading,
    error,
    findHotspots,
  };
}
