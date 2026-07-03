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
// Max radius for each k-means cluster (3 km diameter)
const MAX_CLUSTER_RADIUS_KM = 1.5;
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

export async function fetchOSRMRoute( waypoints: RoutePoint[] ): Promise<{
  coords: RoutePoint[];
  durationSec: number;
}> {
  const wStr = waypoints.map( w => `${w.longitude},${w.latitude}` ).join( ";" );
  const url = `${OSRM_BASE}/${wStr}?overview=full&geometries=geojson`;
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

// Extra distance (km) incurred by visiting `candidate` between stops[idx] and stops[idx + 1]
function insertionCostKm( stops: RoutePoint[], idx: number, candidate: RoutePoint ): number {
  const a = stops[idx];
  const b = stops[idx + 1];
  const direct = haversineKm( a.latitude, a.longitude, b.latitude, b.longitude );
  const viaCost = haversineKm( a.latitude, a.longitude, candidate.latitude, candidate.longitude )
    + haversineKm( candidate.latitude, candidate.longitude, b.latitude, b.longitude );
  return viaCost - direct;
}

// Finds the cheapest place to insert `candidate` into an ordered list of stops,
// returning the index it should be spliced in at.
export function findBestInsertion( stops: RoutePoint[], candidate: RoutePoint ): number {
  let bestIdx = stops.length;
  let bestCost = Infinity;
  for ( let i = 0; i < stops.length - 1; i++ ) {
    const cost = insertionCostKm( stops, i, candidate );
    if ( cost < bestCost ) {
      bestCost = cost;
      bestIdx = i + 1;
    }
  }
  return bestIdx;
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

type LatLng = { lat: number; lng: number };

// Farthest-first k-means: runs for up to maxIter iterations, returns centroids and member indices
function runKMeans(
  points: LatLng[],
  k: number,
  maxIter = 20,
): { centroid: LatLng; memberIndices: number[] }[] {
  const n = points.length;
  const effectiveK = Math.min( k, n );
  if ( effectiveK <= 0 ) return [];

  // Farthest-first initialisation (deterministic)
  const seedIndices: number[] = [0];
  while ( seedIndices.length < effectiveK ) {
    let bestIdx = -1;
    let bestDist = -1;
    for ( let i = 0; i < n; i++ ) {
      if ( seedIndices.includes( i ) ) continue;
      let minD = Infinity;
      for ( const si of seedIndices ) {
        const d = haversineKm( points[i].lat, points[i].lng, points[si].lat, points[si].lng );
        if ( d < minD ) minD = d;
      }
      if ( minD > bestDist ) { bestDist = minD; bestIdx = i; }
    }
    if ( bestIdx < 0 ) break;
    seedIndices.push( bestIdx );
  }

  let centroids: LatLng[] = seedIndices.map( i => ( { ...points[i] } ) );
  let assignments = new Array<number>( n ).fill( 0 );

  for ( let iter = 0; iter < maxIter; iter++ ) {
    const newAssign = points.map( p => {
      let minD = Infinity;
      let best = 0;
      for ( let c = 0; c < centroids.length; c++ ) {
        const d = haversineKm( p.lat, p.lng, centroids[c].lat, centroids[c].lng );
        if ( d < minD ) { minD = d; best = c; }
      }
      return best;
    } );

    if ( iter > 0 && !newAssign.some( ( a, i ) => a !== assignments[i] ) ) break;
    assignments = newAssign;

    const sums = centroids.map( () => ( { lat: 0, lng: 0, n: 0 } ) );
    for ( let i = 0; i < n; i++ ) {
      const c = assignments[i];
      sums[c].lat += points[i].lat;
      sums[c].lng += points[i].lng;
      sums[c].n++;
    }
    centroids = sums.map( ( s, ci ) => s.n > 0
      ? { lat: s.lat / s.n, lng: s.lng / s.n }
      : centroids[ci],
    );
  }

  const groups: { centroid: LatLng; memberIndices: number[] }[] = centroids.map( c => ( {
    centroid: c,
    memberIndices: [],
  } ) );
  for ( let i = 0; i < n; i++ ) groups[assignments[i]].memberIndices.push( i );
  return groups.filter( g => g.memberIndices.length > 0 );
}

// Recursively split a group of points until every cluster fits within maxRadiusKm
function splitToRadiusConstraint(
  points: LatLng[],
  maxRadiusKm: number,
): { centroid: LatLng; memberIndices: number[] }[] {
  if ( points.length === 0 ) return [];

  const [cluster] = runKMeans( points, 1 );
  if ( !cluster ) return [];
  const { centroid } = cluster;

  const exceedsRadius = points.some(
    p => haversineKm( p.lat, p.lng, centroid.lat, centroid.lng ) > maxRadiusKm,
  );
  if ( !exceedsRadius || points.length <= 1 ) return [cluster];

  // Split into two, then recurse on each half
  const halves = runKMeans( points, 2 );
  return halves.flatMap( half => {
    const subPoints = half.memberIndices.map( i => points[i] );
    const subClusters = splitToRadiusConstraint( subPoints, maxRadiusKm );
    return subClusters.map( sc => ( {
      centroid: sc.centroid,
      memberIndices: sc.memberIndices.map( i => half.memberIndices[i] ),
    } ) );
  } );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clusterByKMeans( observations: any[] ): Map<string, {
  centerLat: number;
  centerLng: number;
  count: number;
  taxa: Map<number, HotspotSpecies>;
}> {
  // Extract valid positions paired with their original observation
  const points: LatLng[] = [];
  const obsForPoint: typeof observations = [];
  for ( const obs of observations ) {
    const coords = getObsCoords( obs );
    if ( !coords ) continue;
    points.push( coords );
    obsForPoint.push( obs );
  }

  const clusters = splitToRadiusConstraint( points, MAX_CLUSTER_RADIUS_KM );

  const cells = new Map<string, {
    centerLat: number;
    centerLng: number;
    count: number;
    taxa: Map<number, HotspotSpecies>;
  }>();

  for ( const { centroid, memberIndices } of clusters ) {
    const key = `${centroid.lat.toFixed( 5 )},${centroid.lng.toFixed( 5 )}`;
    const taxa = new Map<number, HotspotSpecies>();
    for ( const i of memberIndices ) {
      const taxon = obsForPoint[i].taxon;
      if ( taxon?.id ) {
        const prev = taxa.get( taxon.id );
        if ( prev ) {
          prev.count++;
        } else {
          taxa.set( taxon.id, {
            id: taxon.id,
            name: taxon.name ?? "",
            preferred_common_name: taxon.preferred_common_name,
            count: 1,
          } );
        }
      }
    }
    cells.set( key, {
      centerLat: centroid.lat,
      centerLng: centroid.lng,
      count: memberIndices.length,
      taxa,
    } );
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
      stops: RoutePoint[],
      filterParams: Record<string, unknown>,
    ) => {
      if ( stops.length < 2 ) return;
      setLoading( true );
      setError( null );
      setHotspots( [] );
      setRouteCoords( [] );

      try {
        // 1. Get the actual road route (through every stop, in order) and baseline travel time
        const { coords: routePoints, durationSec: directDurationSec } = await fetchOSRMRoute( stops );
        setRouteCoords( routePoints );

        // 2. Single iNaturalist call for the whole route bounding box
        const bbox = routeBbox( routePoints );
        const locationFilters = ["swlat", "swlng", "nelat", "nelng", "lat", "lng", "radius", "place_id"];
        const nonLocationParams = Object.fromEntries(
          Object.entries( filterParams ).filter( ([key] ) => !locationFilters.includes( key ) ),
        );
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
          ...nonLocationParams,
        } );

        const observations = response?.results ?? [];

        // 3. Cluster observations with k-means (≤3 km diameter per cluster)
        const cells = clusterByKMeans( observations );

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

        // 5. Compute actual travel time in parallel for each candidate, inserted at
        // whichever point along the current stops minimizes the added distance
        const withDetours = await Promise.all(
          topCandidates.map( async candidate => {
            const point = { latitude: candidate.centerLat, longitude: candidate.centerLng };
            const insertIdx = findBestInsertion( stops, point );
            const withCandidate = [
              ...stops.slice( 0, insertIdx ),
              point,
              ...stops.slice( insertIdx ),
            ];
            const detourSec = await fetchOSRMDuration( withCandidate );
            const detourMinutes = Math.max(
              0,
              Math.round( ( detourSec - directDurationSec ) / 60 ),
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
