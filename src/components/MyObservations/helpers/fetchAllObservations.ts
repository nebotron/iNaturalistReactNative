import { searchObservations } from "api/observations";
import type Realm from "realm";
import Observation from "realmModels/Observation";
import { TAXON_AND_DESCENDANTS_QUERY } from "sharedHelpers/taxonomicSort";
import { sleep } from "sharedHelpers/util";

// Taxonomic order sorts on device, so it needs every observation the current search matches
// downloaded first. Past this many, we ask before downloading them all
export const CONFIRM_FETCH_ALL_OVER = 1000;

// The most the API returns per page
const PER_PAGE = 200;
// The API asks clients to stay at about one request a second
const PAGE_DELAY_MS = 1000;

export interface ObservationsFilter {
  userId: number;
  taxonId?: number;
}

export const observationsFilterKey = ( { userId, taxonId }: ObservationsFilter ) => (
  `${userId}-${taxonId ?? "all"}`
);

const filterParams = ( { userId, taxonId }: ObservationsFilter ) => ( {
  user_id: userId,
  ...( taxonId && { taxon_id: taxonId } ),
} );

export async function countRemoteObservations(
  filter: ObservationsFilter,
  apiToken: string | null,
): Promise<number> {
  const response = await searchObservations(
    { ...filterParams( filter ), per_page: 0, ttl: -1 },
    { api_token: apiToken },
  );
  return response?.total_results ?? 0;
}

// Uploaded observations already on this device that match the filter
export function countLocalObservations( realm: Realm, filter: ObservationsFilter ): number {
  const observations = realm.objects( "Observation" )
    .filtered( "id != nil AND user.id == $0", filter.userId );
  return filter.taxonId
    ? observations.filtered( TAXON_AND_DESCENDANTS_QUERY, filter.taxonId ).length
    : observations.length;
}

// Downloads every observation matching the filter into Realm, newest first. onPage reports
// progress after each page and returns false to stop
export async function fetchAllObservations(
  realm: Realm,
  filter: ObservationsFilter,
  getApiToken: ( ) => Promise<string | null>,
  onPage: ( fetched: number, total: number ) => boolean,
): Promise<void> {
  let idBelow: number | undefined;
  let fetched = 0;
  for ( ;; ) {
    // eslint-disable-next-line no-await-in-loop
    const apiToken = await getApiToken( );
    // eslint-disable-next-line no-await-in-loop
    const response = await searchObservations( {
      ...filterParams( filter ),
      per_page: PER_PAGE,
      order_by: "id",
      order: "desc",
      ...( idBelow && { id_below: idBelow } ),
      fields: Observation.ADVANCED_MODE_LIST_FIELDS,
      ttl: -1,
    }, { api_token: apiToken } );
    const results: { id: number }[] = response?.results || [];
    Observation.upsertRemoteObservations( results, realm );
    fetched += results.length;
    if ( !onPage( fetched, response?.total_results ?? fetched ) ) return;
    if ( results.length < PER_PAGE ) return;
    idBelow = results[results.length - 1].id;
    // eslint-disable-next-line no-await-in-loop
    await sleep( PAGE_DELAY_MS );
  }
}
