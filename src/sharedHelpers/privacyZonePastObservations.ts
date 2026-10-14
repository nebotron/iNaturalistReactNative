import { searchObservations, updateObservation } from "api/observations";
import type Realm from "realm";
import { log } from "sharedHelpers/logger";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import { sleep } from "sharedHelpers/util";
import type { PrivacyZone } from "stores/createPrivacyZoneSlice";

const logger = log.extend( "privacyZonePastObservations" );

const GEOPRIVACY_OBSCURED = "obscured";
const GEOPRIVACY_PRIVATE = "private";

const PER_PAGE = 200;
// The search API refuses to page beyond 10,000 results, so there's no point
// asking for more than that.
const MAX_PAGES = 50;
// One write per observation adds up, and iNaturalist asks clients to stay
// under 100 requests a minute. This paces us at roughly 80.
const MS_BETWEEN_UPDATES = 750;

interface ApiOptions {
  api_token: string | null;
}

// Realm only ever holds the pages of observations the user has actually
// scrolled through, and list responses don't include coordinates, so the set of
// already-uploaded observations inside the zone has to come from the API. It
// supports exactly this query: a point, a radius in kilometers, and a
// geoprivacy filter ("open" also covers observations with no geoprivacy set).
const privacyZoneSearchParams = ( userId: number, zone: PrivacyZone ) => ( {
  user_id: userId,
  lat: zone.latitude,
  lng: zone.longitude,
  radius: zone.radiusMeters / 1000,
  geoprivacy: "open",
  // Bypass API response caching so a just-obscured observation stops matching
  ttl: -1,
} );

export const countUploadedObservationsInPrivacyZone = async (
  userId: number,
  zone: PrivacyZone,
  opts: ApiOptions,
): Promise<number> => {
  const response = await searchObservations( {
    ...privacyZoneSearchParams( userId, zone ),
    per_page: 0,
    fields: { id: true },
  }, opts ) as { total_results?: number } | null;
  return response?.total_results ?? 0;
};

// Every uuid is collected before anything is obscured: obscuring an
// observation drops it out of the search, so paging while mutating would skip
// over roughly half of them.
const fetchUuidsInPrivacyZone = async (
  userId: number,
  zone: PrivacyZone,
  opts: ApiOptions,
): Promise<string[]> => {
  const uuids: string[] = [];
  for ( let page = 1; page <= MAX_PAGES; page += 1 ) {
    // eslint-disable-next-line no-await-in-loop
    const response = await searchObservations( {
      ...privacyZoneSearchParams( userId, zone ),
      per_page: PER_PAGE,
      page,
      order_by: "id",
      order: "asc",
      fields: { uuid: true, geoprivacy: true },
    }, opts ) as {
      results?: { uuid: string; geoprivacy?: string | null }[];
    } | null;
    const results = response?.results ?? [];
    results.forEach( obs => {
      // Belt and braces in case the geoprivacy filter ever returns something
      // that's already at least this private
      if ( obs.geoprivacy === GEOPRIVACY_OBSCURED || obs.geoprivacy === GEOPRIVACY_PRIVATE ) {
        return;
      }
      uuids.push( obs.uuid );
    } );
    if ( results.length < PER_PAGE ) break;
  }
  return uuids;
};

// Keeps Realm's copies in step with what we just changed on the server, so the
// UI doesn't keep showing them as open until the next sync. Deliberately does
// not touch _updated_at: these observations are already up to date remotely and
// must not be queued for re-upload.
const markLocalCopiesObscured = ( realm: Realm, uuids: string[] ) => {
  if ( uuids.length === 0 ) return;
  const quoted = uuids.map( uuid => `'${uuid}'` ).join( ", " );
  const localCopies = realm.objects( "Observation" ).filtered( `uuid IN { ${quoted} }` );
  if ( localCopies.length === 0 ) return;
  safeRealmWrite( realm, ( ) => {
    localCopies.forEach( obs => {
      const mutableObs = obs as unknown as { geoprivacy?: string; obscured?: boolean };
      mutableObs.geoprivacy = GEOPRIVACY_OBSCURED;
      mutableObs.obscured = true;
    } );
  }, "marking local copies obscured for the privacy zone" );
};

export interface ObscureRemoteResult {
  obscured: number;
  failed: number;
}

const obscureUploadedObservationsInPrivacyZone = async (
  realm: Realm,
  userId: number,
  zone: PrivacyZone,
  opts: ApiOptions,
  onProgress?: ( _done: number, _total: number ) => void,
): Promise<ObscureRemoteResult> => {
  const uuids = await fetchUuidsInPrivacyZone( userId, zone, opts );
  const succeeded: string[] = [];
  let failed = 0;

  for ( let i = 0; i < uuids.length; i += 1 ) {
    const uuid = uuids[i];
    try {
      // ignore_photos keeps this a metadata-only update, exactly as the
      // observation uploader does when it modifies an existing observation.
      // eslint-disable-next-line no-await-in-loop
      await updateObservation( {
        id: uuid,
        observation: { uuid, geoprivacy: GEOPRIVACY_OBSCURED },
        fields: { id: true },
        ignore_photos: true,
      }, opts );
      succeeded.push( uuid );
    } catch ( error ) {
      failed += 1;
      logger.error( `Failed to obscure observation ${uuid} in the privacy zone`, error );
    }
    onProgress?.( i + 1, uuids.length );
    if ( i < uuids.length - 1 ) {
      // eslint-disable-next-line no-await-in-loop
      await sleep( MS_BETWEEN_UPDATES );
    }
  }

  markLocalCopiesObscured( realm, succeeded );

  return { obscured: succeeded.length, failed };
};

export default obscureUploadedObservationsInPrivacyZone;
