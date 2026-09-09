import { prefetch } from "@candlefinance/faster-image";
import { fetchRemoteObservations } from "api/observations";
import type { ApiObservation, ApiOpts } from "api/types";
import Observation from "realmModels/Observation";
import Photo from "realmModels/Photo";
import { withRequestTimeout } from "sharedHelpers/logging";
import {
  getCachedObservation,
  MAX_CACHED_OBSERVATIONS,
  setCachedObservations,
} from "sharedHelpers/notificationsCache";

// How many of the most recent notifications we pre-cache the observation for.
// One request covers all of them, so the cost is the size of the response,
// not the number of round trips. Matched to what the cache holds, so nothing
// we fetch is evicted by something else we fetched in the same pass.
export const MAX_PRECACHED_OBSERVATIONS = MAX_CACHED_OBSERVATIONS;

// The notifications we've already pulled the observation down for this
// session. The Notifications tab refetches its list on every focus, and
// without this each of those would drag the whole detail payload down again;
// with it, only a notification we haven't seen before costs a request.
const precachedNotificationIds = new Set<string>( );

// The two sizes an observation reached from a notification is shown at: the
// square thumbnail in the list, and the large photo on ObsDetails.
const photoUrlsFor = ( observations: ApiObservation[] ): string[] => {
  const urls: string[] = [];
  observations.forEach( observation => {
    const url = observation?.observation_photos?.[0]?.photo?.url;
    if ( !url ) return;
    urls.push( url );
    const largeUrl = Photo.displayLargePhoto( url );
    if ( largeUrl && largeUrl !== url ) urls.push( largeUrl );
  } );
  return urls;
};

/**
 * Pre-caches the observations a user has been notified about, so tapping a
 * notification offline opens the observation with its photos, comments and
 * identifications rather than a spinner. A notification only carries enough
 * of its observation to draw a row, so this fetches the full detail
 * ObsDetails needs and persists it alongside the notifications themselves.
 */
export default async function precacheNotifiedObservations(
  notifications: { id?: string | number; resource_uuid?: string }[],
  optsWithAuth: ApiOpts,
): Promise<ApiObservation[]> {
  // Anything we haven't fetched for yet, plus anything whose cached copy is
  // gone — evicted, or cleared when the last user signed out.
  const pending = notifications
    .slice( 0, MAX_PRECACHED_OBSERVATIONS )
    .filter( notification => notification?.resource_uuid )
    .filter( notification => !precachedNotificationIds.has( String( notification.id ) )
      || !getCachedObservation( notification.resource_uuid as string ) );
  const uuids = Array.from( new Set(
    pending.map( notification => notification.resource_uuid ),
  ) ) as string[];
  if ( uuids.length === 0 ) return [];

  // This runs alongside the request that produced the notifications, whose
  // timeout signal is already ticking; withRequestTimeout gives this its own.
  const observations: ApiObservation[] | null = await withRequestTimeout(
    optsWithAuth,
    ( opts: ApiOpts ) => fetchRemoteObservations(
      uuids,
      {
        include_new_projects: true,
        fields: Observation.FIELDS,
      },
      opts,
    ),
  );
  if ( !observations || observations.length === 0 ) return [];

  setCachedObservations( observations );
  pending.forEach( notification => precachedNotificationIds.add( String( notification.id ) ) );
  // Photos live in the image cache rather than in MMKV, so they need warming
  // separately or an observation opens offline without its evidence.
  const urls = photoUrlsFor( observations );
  if ( urls.length > 0 ) prefetch( urls );
  return observations;
}
