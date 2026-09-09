import { prefetch } from "@candlefinance/faster-image";
import NetInfo from "@react-native-community/netinfo";
import { fetchRemoteObservation } from "api/observations";
import type { ApiObservation, ApiOpts } from "api/types";
import Photo from "realmModels/Photo";
import { withRequestTimeout } from "sharedHelpers/logging";
import remoteObservationParams from "sharedHelpers/remoteObservationParams";

// How many of the most recent notifications we fetch the observation for.
// Each is its own request — the HTTP cache keys on the request, so these have
// to be the same one-observation requests ObsDetails will make, not a cheaper
// batched one whose response nothing would ever look up.
export const MAX_PREFETCHED_OBSERVATIONS = 10;

interface NotifiedObservation {
  id?: string | number;
  resource_uuid?: string;
  resource?: ApiObservation;
}

// The notifications we've already pulled the observation down for this
// session. The Notifications tab refetches its list on every focus, and
// without this each of those would drag every detail payload down again;
// with it, only a notification we haven't seen before costs a request.
const prefetchedNotificationIds = new Set<string>( );

// The two sizes an observation reached from a notification is shown at: the
// square thumbnail in the list, and the large photo on ObsDetails. Photos
// live in the image cache rather than the HTTP one, so they need warming
// separately or an observation opens offline without its evidence.
const photoUrlsFor = ( notifications: NotifiedObservation[] ): string[] => {
  const urls: string[] = [];
  notifications.forEach( notification => {
    const url = notification?.resource?.observation_photos?.[0]?.photo?.url;
    if ( !url ) return;
    urls.push( url );
    const largeUrl = Photo.displayLargePhoto( url );
    if ( largeUrl && largeUrl !== url ) urls.push( largeUrl );
  } );
  return urls;
};

/**
 * Asks for the observations a user has been notified about, so tapping a
 * notification offline opens the observation with its photos, comments and
 * identifications rather than a spinner.
 *
 * Nothing here stores anything itself. These are the very requests ObsDetails
 * makes, issued early; the HTTP cache keeps the responses, and the screen's
 * own request finds them there when there's no network.
 */
export default async function prefetchNotifiedObservations(
  notifications: NotifiedObservation[],
  optsWithAuth: ApiOpts,
): Promise<void> {
  // With no connection these requests would only be answered from the cache
  // we're trying to fill, so there is nothing to warm.
  const { isConnected } = await NetInfo.fetch( );
  if ( isConnected === false ) return;

  const pending = notifications
    .slice( 0, MAX_PREFETCHED_OBSERVATIONS )
    .filter( notification => notification?.resource_uuid )
    .filter( notification => !prefetchedNotificationIds.has( String( notification.id ) ) );
  if ( pending.length === 0 ) return;

  prefetch( photoUrlsFor( pending ) );

  const uuids = Array.from( new Set( pending.map( n => n.resource_uuid ) ) ) as string[];
  await Promise.all( uuids.map( async uuid => {
    // These run alongside the request that produced the notifications, whose
    // timeout signal is already ticking; withRequestTimeout gives each its own.
    await withRequestTimeout( optsWithAuth, ( opts: ApiOpts ) => fetchRemoteObservation(
      uuid,
      remoteObservationParams( ),
      opts,
    ) );
  } ) );

  pending.forEach( notification => prefetchedNotificationIds.add( String( notification.id ) ) );
}
