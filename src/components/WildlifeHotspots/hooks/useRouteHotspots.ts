import { searchObservations } from "api/observations";
import i18n from "i18next";
import { useCallback, useRef, useState } from "react";
import { distanceInKm, EARTH_RADIUS_KM } from "sharedHelpers/geoDistance";
import type { HotspotSettings } from "stores/createLayoutSlice";
import { DEFAULT_HOTSPOT_SETTINGS } from "stores/createLayoutSlice";

export interface RoutePoint {
  latitude: number;
  longitude: number;
}

export interface HotspotSpecies {
  id?: number;
  name: string;
  preferred_common_name?: string;
  count: number;
}

export interface HotspotObservation {
  uuid: string;
  latitude: number;
  longitude: number;
}

export interface Circle { lat: number; lng: number; radiusKm: number }

export interface Hotspot {
  id: string;
  centerLatitude: number;
  centerLongitude: number;
  // Smallest circle containing every observation in the cluster
  area: Circle;
  observationCount: number;
  detourMinutes: number;
  speciesCount: number;
  topSpecies: HotspotSpecies[];
  observations: HotspotObservation[];
}

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
const OSRM_TABLE_BASE = "https://router.project-osrm.org/table/v1/driving";
// Hotspot settings ride along in filterParams but aren't iNaturalist API params
const HOTSPOT_PARAM_KEYS = Object.keys( DEFAULT_HOTSPOT_SETTINGS );

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

// Driving times in seconds between every pair of points, Infinity where unroutable
export async function fetchOSRMDurationMatrix( points: RoutePoint[] ): Promise<number[][]> {
  const wStr = points.map( w => `${w.longitude},${w.latitude}` ).join( ";" );
  const response = await fetch( `${OSRM_TABLE_BASE}/${wStr}?annotations=duration` );
  if ( !response.ok ) {
    throw new Error( `Routing service error: ${response.status}` );
  }
  const data = await response.json();
  if ( !data.durations ) throw new Error( "No travel times found between these locations" );
  return ( data.durations as ( number | null )[][] )
    .map( row => row.map( d => d ?? Infinity ) );
}

// Extra distance (km) incurred by visiting `candidate` between stops[idx] and stops[idx + 1]
function insertionCostKm( stops: RoutePoint[], idx: number, candidate: RoutePoint ): number {
  const a = stops[idx];
  const b = stops[idx + 1];
  const direct = distanceInKm( a.latitude, a.longitude, b.latitude, b.longitude );
  const viaCost = distanceInKm( a.latitude, a.longitude, candidate.latitude, candidate.longitude )
    + distanceInKm( candidate.latitude, candidate.longitude, b.latitude, b.longitude );
  return viaCost - direct;
}

// Finds the cheapest place to insert `candidate` into an ordered list of stops,
// returning the index it should be spliced in at.
export function findBestInsertion( stops: RoutePoint[], candidate: RoutePoint ): number {
  let bestIdx = stops.length;
  let bestCost = Infinity;
  for ( let i = 0; i < stops.length - 1; i += 1 ) {
    const cost = insertionCostKm( stops, i, candidate );
    if ( cost < bestCost ) {
      bestCost = cost;
      bestIdx = i + 1;
    }
  }
  return bestIdx;
}

// The public OSRM server rejects table requests with more than 100 coordinates
const OSRM_TABLE_MAX_COORDS = 100;

// Seconds of driving each candidate adds to the route through `stops` when inserted
// where findBestInsertion puts it (the same place adding it to the route does).
// Infinity where unroutable.
async function fetchDetoursSec(
  stops: RoutePoint[],
  candidates: RoutePoint[],
): Promise<number[]> {
  const chunkSize = Math.max( 1, OSRM_TABLE_MAX_COORDS - stops.length );
  const chunks: RoutePoint[][] = [];
  for ( let i = 0; i < candidates.length; i += chunkSize ) {
    chunks.push( candidates.slice( i, i + chunkSize ) );
  }
  const results = await Promise.allSettled(
    chunks.map( chunk => fetchOSRMDurationMatrix( [...stops, ...chunk] ) ),
  );
  if ( chunks.length > 0 && results.every( r => r.status === "rejected" ) ) {
    throw ( results[0] as PromiseRejectedResult ).reason;
  }
  return results.flatMap( ( result, chunkIdx ) => chunks[chunkIdx].map( ( candidate, j ) => {
    if ( result.status === "rejected" ) return Infinity;
    const durations = result.value;
    const p = stops.length + j;
    const insertIdx = findBestInsertion( stops, candidate );
    const a = insertIdx - 1;
    const b = insertIdx;
    return durations[a][p] + durations[p][b] - durations[a][b];
  } ) );
}

// Km per degree of latitude/longitude, used to pad the bbox by a fixed distance
const KM_PER_DEG_LAT = ( EARTH_RADIUS_KM * Math.PI ) / 180;

function routeBbox( coords: RoutePoint[], paddingKm: number ) {
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
  const latPaddingDeg = paddingKm / KM_PER_DEG_LAT;
  const midLat = ( minLat + maxLat ) / 2;
  const lngPaddingDeg = paddingKm / ( KM_PER_DEG_LAT * Math.cos( ( midLat * Math.PI ) / 180 ) );
  return {
    swlat: minLat - latPaddingDeg,
    swlng: minLng - lngPaddingDeg,
    nelat: maxLat + latPaddingDeg,
    nelng: maxLng + lngPaddingDeg,
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

interface LatLng { lat: number; lng: number }

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
    for ( let i = 0; i < n; i += 1 ) {
      if ( !seedIndices.includes( i ) ) {
        let minD = Infinity;
        for ( const si of seedIndices ) {
          const d = distanceInKm( points[i].lat, points[i].lng, points[si].lat, points[si].lng );
          if ( d < minD ) minD = d;
        }
        if ( minD > bestDist ) { bestDist = minD; bestIdx = i; }
      }
    }
    if ( bestIdx < 0 ) break;
    seedIndices.push( bestIdx );
  }

  let centroids: LatLng[] = seedIndices.map( i => ( { ...points[i] } ) );
  let assignments = new Array<number>( n ).fill( 0 );

  for ( let iter = 0; iter < maxIter; iter += 1 ) {
    const currentCentroids = centroids;
    const newAssign = points.map( p => {
      let minD = Infinity;
      let best = 0;
      for ( let c = 0; c < currentCentroids.length; c += 1 ) {
        const d = distanceInKm( p.lat, p.lng, currentCentroids[c].lat, currentCentroids[c].lng );
        if ( d < minD ) { minD = d; best = c; }
      }
      return best;
    } );

    const prevAssignments = assignments;
    if ( iter > 0 && !newAssign.some( ( a, i ) => a !== prevAssignments[i] ) ) break;
    assignments = newAssign;

    const sums = currentCentroids.map( () => ( { lat: 0, lng: 0, n: 0 } ) );
    for ( let i = 0; i < n; i += 1 ) {
      const c = assignments[i];
      sums[c].lat += points[i].lat;
      sums[c].lng += points[i].lng;
      sums[c].n += 1;
    }
    centroids = sums.map( ( s, ci ) => ( s.n > 0
      ? { lat: s.lat / s.n, lng: s.lng / s.n }
      : currentCentroids[ci] ) );
  }

  const groups: { centroid: LatLng; memberIndices: number[] }[] = centroids.map( c => ( {
    centroid: c,
    memberIndices: [],
  } ) );
  for ( let i = 0; i < n; i += 1 ) groups[assignments[i]].memberIndices.push( i );
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
    p => distanceInKm( p.lat, p.lng, centroid.lat, centroid.lng ) > maxRadiusKm,
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

// Smallest circle containing all points (Welzl's incremental algorithm), on a
// local flat projection, which is accurate at hotspot scale
function enclosingCircle( points: LatLng[] ): Circle {
  const lat0 = points[0].lat;
  const kmPerDegLat = ( Math.PI * EARTH_RADIUS_KM ) / 180;
  const kmPerDegLng = kmPerDegLat * Math.cos( ( lat0 * Math.PI ) / 180 );
  const pts = points.map( p => ( { x: p.lng * kmPerDegLng, y: p.lat * kmPerDegLat } ) );
  interface C { x: number; y: number; r: number }
  const contains = ( c: C, p: { x: number; y: number } ) => (
    Math.hypot( p.x - c.x, p.y - c.y ) <= c.r * ( 1 + 1e-9 ) + 1e-9
  );
  const fromTwo = ( a: typeof pts[0], b: typeof pts[0] ): C => ( {
    x: ( a.x + b.x ) / 2,
    y: ( a.y + b.y ) / 2,
    r: Math.hypot( a.x - b.x, a.y - b.y ) / 2,
  } );
  const fromThree = ( a: typeof pts[0], b: typeof pts[0], c: typeof pts[0] ): C => {
    const d = 2 * ( a.x * ( b.y - c.y ) + b.x * ( c.y - a.y ) + c.x * ( a.y - b.y ) );
    // Collinear: the two farthest-apart points define the circle
    if ( d === 0 ) {
      return [fromTwo( a, b ), fromTwo( a, c ), fromTwo( b, c )]
        .reduce( ( m, cand ) => ( cand.r > m.r
          ? cand
          : m ) );
    }
    const a2 = a.x * a.x + a.y * a.y;
    const b2 = b.x * b.x + b.y * b.y;
    const c2 = c.x * c.x + c.y * c.y;
    const x = ( a2 * ( b.y - c.y ) + b2 * ( c.y - a.y ) + c2 * ( a.y - b.y ) ) / d;
    const y = ( a2 * ( c.x - b.x ) + b2 * ( a.x - c.x ) + c2 * ( b.x - a.x ) ) / d;
    return { x, y, r: Math.hypot( a.x - x, a.y - y ) };
  };
  let c: C = { ...pts[0], r: 0 };
  for ( let i = 1; i < pts.length; i += 1 ) {
    if ( !contains( c, pts[i] ) ) {
      c = { ...pts[i], r: 0 };
      for ( let j = 0; j < i; j += 1 ) {
        if ( !contains( c, pts[j] ) ) {
          c = fromTwo( pts[i], pts[j] );
          for ( let k = 0; k < j; k += 1 ) {
            if ( !contains( c, pts[k] ) ) c = fromThree( pts[i], pts[j], pts[k] );
          }
        }
      }
    }
  }
  return { lat: c.y / kmPerDegLat, lng: c.x / kmPerDegLng, radiusKm: c.r };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clusterByKMeans( observations: any[], maxRadiusKm: number ): Map<string, {
  centerLat: number;
  centerLng: number;
  area: Circle;
  count: number;
  taxa: Map<number | string, HotspotSpecies>;
  observations: HotspotObservation[];
}> {
  // Extract valid positions paired with their original observation
  const points: LatLng[] = [];
  const obsForPoint: typeof observations = [];
  for ( const obs of observations ) {
    const coords = getObsCoords( obs );
    if ( coords ) {
      points.push( coords );
      obsForPoint.push( obs );
    }
  }

  const clusters = splitToRadiusConstraint( points, maxRadiusKm );

  const cells = new Map<string, {
    centerLat: number;
    centerLng: number;
    area: Circle;
    count: number;
    taxa: Map<number | string, HotspotSpecies>;
    observations: HotspotObservation[];
  }>();

  for ( const { centroid, memberIndices } of clusters ) {
    const key = `${centroid.lat.toFixed( 5 )},${centroid.lng.toFixed( 5 )}`;
    const taxa = new Map<number | string, HotspotSpecies>();
    const cellObservations: HotspotObservation[] = [];
    // Observations of the same species on the same day count once
    const seenSpeciesDays = new Set<string>();
    let count = 0;
    for ( const i of memberIndices ) {
      const obs = obsForPoint[i];
      const { taxon } = obs;
      const taxonKey: number | string | undefined = taxon?.id ?? taxon?.name;
      const day = obs.observed_on ?? obs.time_observed_at?.slice( 0, 10 );
      const speciesDayKey = taxonKey && day
        ? `${taxonKey}|${day}`
        : null;
      const isDuplicate = speciesDayKey !== null && seenSpeciesDays.has( speciesDayKey );
      if ( speciesDayKey ) seenSpeciesDays.add( speciesDayKey );
      if ( !isDuplicate ) count += 1;
      if ( taxonKey && !isDuplicate ) {
        const prev = taxa.get( taxonKey );
        if ( prev ) {
          prev.count += 1;
        } else {
          taxa.set( taxonKey, {
            id: taxon.id,
            name: taxon.name ?? "",
            preferred_common_name: taxon.preferred_common_name,
            count: 1,
          } );
        }
      }
      if ( obs.uuid ) {
        cellObservations.push( {
          uuid: obs.uuid,
          latitude: points[i].lat,
          longitude: points[i].lng,
        } );
      }
    }
    cells.set( key, {
      centerLat: centroid.lat,
      centerLng: centroid.lng,
      area: enclosingCircle( memberIndices.map( i => points[i] ) ),
      count,
      taxa,
      observations: cellObservations,
    } );
  }

  return cells;
}

export function useRouteHotspots() {
  const [hotspots, setHotspots] = useState<Hotspot[]>( [] );
  // Every hotspot whose detour was evaluated, for route planning
  const [candidates, setCandidates] = useState<Hotspot[]>( [] );
  const [routeCoords, setRouteCoords] = useState<RoutePoint[]>( [] );
  const [routeDurationSec, setRouteDurationSec] = useState<number | null>( null );
  const [loading, setLoading] = useState( false );
  const [error, setError] = useState<string | null>( null );
  // Only the latest search may set results, so a slow earlier one run with
  // old params can't overwrite it.
  const latestRequestRef = useRef( 0 );

  const findHotspots = useCallback(
    async (
      stops: RoutePoint[],
      filterParams: Record<string, unknown>,
    ) => {
      if ( stops.length < 2 ) return;
      latestRequestRef.current += 1;
      const requestId = latestRequestRef.current;
      const isStale = () => requestId !== latestRequestRef.current;
      setLoading( true );
      setError( null );
      setHotspots( [] );
      setCandidates( [] );
      setRouteCoords( [] );
      setRouteDurationSec( null );

      try {
        // 1. Get the actual road route (through every stop, in order) and baseline travel time
        const {
          coords: routePoints,
          durationSec: directDurationSec,
        } = await fetchOSRMRoute( stops );
        if ( isStale() ) return;
        setRouteCoords( routePoints );
        setRouteDurationSec( directDurationSec );

        // Hotspot settings from filterParams, or their defaults
        const setting = ( key: keyof HotspotSettings ) => (
          filterParams[key] as number | undefined
        ) ?? DEFAULT_HOTSPOT_SETTINGS[key];
        const clusterRadiusKm = setting( "hotspotClusterRadiusKm" );
        const maxDetourCandidates = setting( "hotspotMaxDetourCandidates" );
        const parkingMinutes = setting( "hotspotParkingMinutes" );
        const bboxPaddingKm = setting( "hotspotBboxPaddingKm" );
        const totalObs = setting( "hotspotObsPerPage" );
        const API_PAGE_SIZE = 200; // iNaturalist API cap

        // 2. iNaturalist calls for the whole route bounding box, paginating until
        // we reach the requested total (each page is capped at 200 by the API)
        const bbox = routeBbox( routePoints, bboxPaddingKm );
        const nonApiParamKeys = [
          "swlat", "swlng", "nelat", "nelng", "lat", "lng", "radius", "place_id",
          "per_page", "page",
          ...HOTSPOT_PARAM_KEYS,
        ];
        const nonLocationParams = Object.fromEntries(
          Object.entries( filterParams ).filter( ( [key] ) => !nonApiParamKeys.includes( key ) ),
        );
        const fetchPage = ( page: number ) => searchObservations( {
          ...bbox,
          per_page: API_PAGE_SIZE,
          page,
          verifiable: true,
          order_by: "observed_on",
          order: "desc",
          fields: {
            uuid: true,
            geojson: true,
            time_observed_at: true,
            observed_on: true,
            taxon: {
              id: true,
              name: true,
              preferred_common_name: true,
              iconic_taxon_name: true,
            },
          },
          ...nonLocationParams,
        } );
        const numPages = Math.ceil( totalObs / API_PAGE_SIZE );
        const pages = await Promise.all(
          Array.from( { length: numPages }, ( _, i ) => fetchPage( i + 1 ) ),
        );

        if ( isStale() ) return;
        const observations = pages.flatMap( p => p?.results ?? [] ).slice( 0, totalObs );

        // 3. Cluster observations with k-means (diameter ≤ 2× clusterRadiusKm per cluster)
        const cells = clusterByKMeans( observations, clusterRadiusKm );

        // 4. Filter to cells within MAX_ROUTE_DISTANCE_KM, take top candidates by obs count
        const candidates: {
          id: string;
          centerLat: number;
          centerLng: number;
          area: Circle;
          count: number;
          speciesCount: number;
          topSpecies: HotspotSpecies[];
          observations: HotspotObservation[];
        }[] = [];

        cells.forEach( ( cell, key ) => {
          const topSpecies: HotspotSpecies[] = [...cell.taxa.values()]
            .sort( ( a, b ) => b.count - a.count )
            .slice( 0, 3 );

          candidates.push( {
            id: `hotspot-${key}`,
            centerLat: cell.centerLat,
            centerLng: cell.centerLng,
            area: cell.area,
            count: cell.count,
            speciesCount: cell.taxa.size,
            topSpecies,
            observations: cell.observations,
          } );
        } );

        candidates.sort( ( a, b ) => b.count - a.count );
        const topCandidates = candidates.slice( 0, maxDetourCandidates );

        // 5. Driving time added by visiting each candidate between the two stops it's
        // inserted between: d(A,P) + d(P,B) - d(A,B). OSRM table requests cover every
        // candidate in a few calls instead of one route request each.
        const detoursSec = await fetchDetoursSec(
          stops,
          topCandidates.map( c => ( { latitude: c.centerLat, longitude: c.centerLng } ) ),
        );
        if ( isStale() ) return;
        const withDetours: Hotspot[] = [];
        topCandidates.forEach( ( candidate, i ) => {
          if ( !Number.isFinite( detoursSec[i] ) ) return;
          withDetours.push( {
            id: candidate.id,
            centerLatitude: candidate.centerLat,
            centerLongitude: candidate.centerLng,
            area: candidate.area,
            observationCount: candidate.count,
            detourMinutes: Math.max( 0, Math.round( detoursSec[i] / 60 ) ),
            speciesCount: candidate.speciesCount,
            topSpecies: candidate.topSpecies,
            observations: candidate.observations,
          } );
        } );

        // 6. Rank by ratio of added travel time to observations (lower = better)
        withDetours.sort( ( a, b ) => {
          const ratioA = ( a.detourMinutes + parkingMinutes ) / a.observationCount;
          const ratioB = ( b.detourMinutes + parkingMinutes ) / b.observationCount;
          return ratioA - ratioB;
        } );

        if ( isStale() ) return;
        setHotspots( withDetours.slice( 0, 10 ) );
        setCandidates( withDetours );
      } catch ( err ) {
        if ( isStale() ) return;
        setError( err instanceof Error
          ? err.message
          : i18n.t( "Failed-to-load-hotspot-data" ) );
      } finally {
        if ( !isStale() ) setLoading( false );
      }
    },
    [],
  );

  return {
    hotspots,
    candidates,
    routeCoords,
    routeDurationSec,
    loading,
    error,
    findHotspots,
  };
}
