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
  distanceFromRouteKm: number;
  topSpecies: HotspotSpecies[];
}

const EARTH_RADIUS_KM = 6371;
const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
// ~3 km grid cells for clustering (1° ≈ 111 km)
const GRID_DEG = 0.027;
// Hotspots must be within this distance of the route to be shown
const MAX_ROUTE_DISTANCE_KM = 25;

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

async function fetchOSRMRoute( start: RoutePoint, end: RoutePoint ): Promise<RoutePoint[]> {
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
  return coords.map( ( [lng, lat] ) => ( { latitude: lat, longitude: lng } ) );
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
        // 1. Get the actual road route
        const routePoints = await fetchOSRMRoute( start, end );
        setRouteCoords( routePoints );

        // 2. Fetch 500 observations for the route bounding box.
        //    The API caps at 200/page, so fetch pages 1–3 in parallel.
        const bbox = routeBbox( routePoints );
        const obsParams = {
          ...bbox,
          per_page: 200,
          verifiable: true,
          order_by: "observations.id",
          fields: {
            geojson: true,
            taxon: {
              id: true,
              name: true,
              preferred_common_name: true,
              iconic_taxon_name: true,
            },
          },
          ...filterParams,
        };
        const [page1, page2, page3] = await Promise.all( [
          searchObservations( { ...obsParams, page: 1 } ),
          searchObservations( { ...obsParams, page: 2 } ),
          searchObservations( { ...obsParams, page: 3 } ),
        ] );
        const observations = [
          ...( page1?.results ?? [] ),
          ...( page2?.results ?? [] ),
          ...( page3?.results ?? [] ),
        ];

        // 3. Cluster observations into geographic grid cells
        const cells = clusterByGrid( observations );

        // 4. Filter to cells within MAX_ROUTE_DISTANCE_KM of the route,
        //    then sort by observation count
        const results: Hotspot[] = [];
        cells.forEach( ( cell, key ) => {
          const dist = distanceToPolylineKm(
            { latitude: cell.centerLat, longitude: cell.centerLng },
            routePoints,
          );
          if ( dist > MAX_ROUTE_DISTANCE_KM ) return;

          const topSpecies = [...cell.taxa.values()]
            .sort( ( a, b ) => b.count - a.count )
            .slice( 0, 5 );

          results.push( {
            id: `hotspot-${key}`,
            centerLatitude: cell.centerLat,
            centerLongitude: cell.centerLng,
            observationCount: cell.count,
            distanceFromRouteKm: dist,
            topSpecies,
          } );
        } );

        results.sort( ( a, b ) => b.observationCount - a.observationCount );
        setHotspots( results );
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
