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
  meanTimeOfDay?: string;
}

interface HotspotSpeciesBuilder extends HotspotSpecies {
  timeSinSum: number;
  timeCosSum: number;
  timeCount: number;
}

export interface HotspotObservation {
  uuid: string;
  latitude: number;
  longitude: number;
}

export interface Hotspot {
  id: string;
  centerLatitude: number;
  centerLongitude: number;
  observationCount: number;
  detourMinutes: number;
  topSpecies: HotspotSpecies[];
  observations: HotspotObservation[];
}

const EARTH_RADIUS_KM = 6371;
const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
// Max radius for each k-means cluster (2 km diameter)
const MAX_CLUSTER_RADIUS_KM = 1.5;
// Evaluate detour times for this many top-by-obs candidates
const MAX_DETOUR_CANDIDATES = 50;
// Extra minutes added to travel time to account for parking when ranking hotspots
const PARKING_MINUTES = 5;
// Bbox padding around route to look for observations
const BBOX_PADDING_KM = 80;

const HOTSPOT_PARAM_KEYS = [
  "hotspotClusterRadiusKm",
  "hotspotMaxDetourCandidates",
  "hotspotObsPerPage",
  "hotspotParkingMinutes",
  "hotspotBboxPaddingKm",
];

function parseTimeToMinutes( timeStr: string ): number | null {
  const match = timeStr.match( /T(\d{2}):(\d{2})/ );
  if ( !match ) return null;
  return parseInt( match[1], 10 ) * 60 + parseInt( match[2], 10 );
}

function circularMeanMinutes( sinSum: number, cosSum: number, count: number ): number {
  const meanAngle = Math.atan2( sinSum / count, cosSum / count );
  const normalized = meanAngle < 0
    ? meanAngle + 2 * Math.PI
    : meanAngle;
  return ( normalized / ( 2 * Math.PI ) ) * 1440;
}

function minutesToAmPm( minutes: number ): string {
  const total = Math.round( minutes );
  const h = Math.floor( total / 60 ) % 24;
  const m = total % 60;
  const ampm = h >= 12
    ? "PM"
    : "AM";
  const h12 = h % 12 === 0
    ? 12
    : h % 12;
  return `~${h12}:${m.toString().padStart( 2, "0" )} ${ampm}`;
}

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

// Km per degree of latitude/longitude, used to pad the bbox by a fixed distance
const KM_PER_DEG_LAT = ( EARTH_RADIUS_KM * Math.PI ) / 180;

function routeBbox( coords: RoutePoint[], paddingKm = BBOX_PADDING_KM ) {
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
  const lngPaddingDeg = paddingKm / ( KM_PER_DEG_LAT * Math.cos( toRad( midLat ) ) );
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
    centroids = sums.map( ( s, ci ) => ( s.n > 0
      ? { lat: s.lat / s.n, lng: s.lng / s.n }
      : centroids[ci] ) );
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
function clusterByKMeans( observations: any[], maxRadiusKm = MAX_CLUSTER_RADIUS_KM ): Map<string, {
  centerLat: number;
  centerLng: number;
  count: number;
  taxa: Map<number, HotspotSpeciesBuilder>;
  observations: HotspotObservation[];
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

  const clusters = splitToRadiusConstraint( points, maxRadiusKm );

  const cells = new Map<string, {
    centerLat: number;
    centerLng: number;
    count: number;
    taxa: Map<number, HotspotSpeciesBuilder>;
    observations: HotspotObservation[];
  }>();

  for ( const { centroid, memberIndices } of clusters ) {
    const key = `${centroid.lat.toFixed( 5 )},${centroid.lng.toFixed( 5 )}`;
    const taxa = new Map<number, HotspotSpeciesBuilder>();
    const cellObservations: HotspotObservation[] = [];
    for ( const i of memberIndices ) {
      const obs = obsForPoint[i];
      const { taxon } = obs;
      if ( taxon?.id ) {
        const prev = taxa.get( taxon.id );
        const timeMinutes = obs.time_observed_at
          ? parseTimeToMinutes( obs.time_observed_at )
          : null;
        if ( prev ) {
          prev.count++;
          if ( timeMinutes !== null ) {
            const angle = ( timeMinutes / 1440 ) * 2 * Math.PI;
            prev.timeSinSum += Math.sin( angle );
            prev.timeCosSum += Math.cos( angle );
            prev.timeCount++;
          }
        } else {
          const timeSinSum = timeMinutes !== null
            ? Math.sin( ( timeMinutes / 1440 ) * 2 * Math.PI )
            : 0;
          const timeCosSum = timeMinutes !== null
            ? Math.cos( ( timeMinutes / 1440 ) * 2 * Math.PI )
            : 0;
          taxa.set( taxon.id, {
            id: taxon.id,
            name: taxon.name ?? "",
            preferred_common_name: taxon.preferred_common_name,
            count: 1,
            timeSinSum,
            timeCosSum,
            timeCount: timeMinutes !== null
              ? 1
              : 0,
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
      count: memberIndices.length,
      taxa,
      observations: cellObservations,
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

        // Read algorithm constants from filterParams (with fallbacks to module defaults)
        const clusterRadiusKm = ( filterParams.hotspotClusterRadiusKm as number | undefined )
          ?? MAX_CLUSTER_RADIUS_KM;
        const maxDetourCandidates = ( filterParams.hotspotMaxDetourCandidates as number | undefined )
          ?? MAX_DETOUR_CANDIDATES;
        const parkingMinutes = ( filterParams.hotspotParkingMinutes as number | undefined )
          ?? PARKING_MINUTES;
        const bboxPaddingKm = ( filterParams.hotspotBboxPaddingKm as number | undefined )
          ?? BBOX_PADDING_KM;
        const totalObs = ( filterParams.hotspotObsPerPage as number | undefined ) ?? 200;
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

        const observations = pages.flatMap( p => p?.results ?? [] ).slice( 0, totalObs );

        // 3. Cluster observations with k-means (diameter ≤ 2× clusterRadiusKm per cluster)
        const cells = clusterByKMeans( observations, clusterRadiusKm );

        // 4. Filter to cells within MAX_ROUTE_DISTANCE_KM, take top candidates by obs count
        const candidates: {
          id: string;
          centerLat: number;
          centerLng: number;
          count: number;
          topSpecies: HotspotSpecies[];
          observations: HotspotObservation[];
        }[] = [];

        cells.forEach( ( cell, key ) => {
          const topSpecies: HotspotSpecies[] = [...cell.taxa.values()]
            .sort( ( a, b ) => b.count - a.count )
            .slice( 0, 5 )
            .map( ( {
              timeSinSum, timeCosSum, timeCount, ...species
            } ) => ( {
              ...species,
              meanTimeOfDay: timeCount > 0
                ? minutesToAmPm( circularMeanMinutes( timeSinSum, timeCosSum, timeCount ) )
                : undefined,
            } ) );

          candidates.push( {
            id: `hotspot-${key}`,
            centerLat: cell.centerLat,
            centerLng: cell.centerLng,
            count: cell.count,
            topSpecies,
            observations: cell.observations,
          } );
        } );

        candidates.sort( ( a, b ) => b.count - a.count );
        const topCandidates = candidates.slice( 0, maxDetourCandidates );

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
              observations: candidate.observations,
            };
          } ),
        );

        // 6. Rank by ratio of added travel time to observations (lower = better)
        withDetours.sort( ( a, b ) => {
          const ratioA = ( a.detourMinutes + parkingMinutes ) / a.observationCount;
          const ratioB = ( b.detourMinutes + parkingMinutes ) / b.observationCount;
          return ratioA - ratioB;
        } );

        setHotspots( withDetours.slice( 0, 10 ) );
      } catch ( err ) {
        setError( err instanceof Error
          ? err.message
          : "Failed to load hotspot data" );
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
