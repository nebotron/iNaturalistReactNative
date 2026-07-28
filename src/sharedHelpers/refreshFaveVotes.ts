import { searchObservations } from "api/observations";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import type Realm from "realm";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";

import { log } from "./logger";

const logger = log.extend( "refreshFaveVotes" );

const PER_PAGE = 200;
// Safety valve: 100 pages covers 20k observations.
const MAX_PAGES = 100;

interface ApiVote {
  id: number;
  created_at?: string | null;
  user_id: number;
  vote_flag: boolean;
  vote_scope?: string | null;
}

interface ApiObservationVotes {
  uuid: string;
  votes?: ApiVote[];
}

// Realm's generated Observation type doesn't surface votes, but it exists at
// runtime (see realmModels/Observation.js).
interface VotableRealmObservation {
  isValid: ( ) => boolean;
  votes?: { id: number }[];
}

const VOTE_FIELDS = {
  id: true,
  user_id: true,
  vote_flag: true,
  vote_scope: true,
};

const toRealmVote = ( vote: ApiVote ) => ( {
  id: vote.id,
  created_at: vote.created_at ?? null,
  user_id: vote.user_id,
  vote_flag: vote.vote_flag,
  vote_scope: vote.vote_scope ?? null,
} );

// Two vote lists are equivalent when the same vote ids are present, which is
// all we need to decide whether a Realm write is worth doing.
const sameVoteIds = ( a: { id: number }[], b: { id: number }[] ): boolean => {
  if ( a.length !== b.length ) {
    return false;
  }
  const ids = new Set( a.map( vote => vote.id ) );
  return b.every( vote => ids.has( vote.id ) );
};

// Writes one page of server votes onto the matching local observations,
// returning how many actually changed.
const writeVotesToRealm = ( realm: Realm, results: ApiObservationVotes[] ): number => {
  let updated = 0;
  safeRealmWrite( realm, ( ) => {
    results.forEach( result => {
      const observation = realm.objectForPrimaryKey(
        "Observation",
        result.uuid,
      ) as VotableRealmObservation | null;
      if ( !observation || !observation.isValid( ) ) {
        return;
      }
      const remoteVotes = ( result.votes || [] ).map( toRealmVote );
      const localVotes = Array.from( observation.votes || [] );
      if ( sameVoteIds( localVotes, remoteVotes ) ) {
        return;
      }
      observation.votes = remoteVotes;
      updated += 1;
    } );
  }, "refreshing fave votes from the server" );
  return updated;
};

// Pulls the current user's fave votes down from the server and writes them onto
// the matching local Realm observations. Faves can change anywhere — another
// device, the website, an older build of this app that didn't persist the
// toggle — and nothing else in the app reconciles them for observations outside
// the first page of the MyObservations sync. Anything that decides what to do
// based on "did I favorite this" (Delete Unfaved) needs them current first.
//
// Only the `votes` property is touched: a full upsert from this minimal field
// set would blank out photos and everything else we didn't request.
//
// Returns the number of observations whose votes changed. Failures are logged
// and swallowed — callers fall back to whatever votes Realm already has.
const refreshFaveVotes = async (
  realm: Realm,
  currentUserId?: number | null,
): Promise<number> => {
  if ( !currentUserId ) {
    return 0;
  }
  let updated = 0;
  try {
    const apiToken = await getJWT( );
    let page = 1;
    let done = false;
    while ( !done && page <= MAX_PAGES ) {
      // eslint-disable-next-line no-await-in-loop
      const response = await searchObservations( {
        user_id: currentUserId,
        per_page: PER_PAGE,
        page,
        fields: { uuid: true, votes: VOTE_FIELDS },
        ttl: -1,
      }, { api_token: apiToken } );
      const results: ApiObservationVotes[] = response?.results || [];
      if ( results.length === 0 ) {
        break;
      }
      updated += writeVotesToRealm( realm, results );
      done = results.length < PER_PAGE;
      page += 1;
    }
  } catch ( error ) {
    logger.error( "Failed to refresh fave votes", error );
  }
  return updated;
};

export default refreshFaveVotes;
