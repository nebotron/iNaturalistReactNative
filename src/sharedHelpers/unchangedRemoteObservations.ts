/* eslint-disable no-bitwise */
import type Realm from "realm";

// A list refetch (My Observations pages, pull to refresh, every return to the
// tab) mostly returns observations exactly as they were, and writing one anyway
// is never a no-op: _synced_at changes, and the embedded photo, sound, field
// value and project lists are deleted and recreated wholesale, because
// "modified" can't merge into embedded objects. That made My Observations the
// app's heaviest disk writer by far (~400 MB/min while open, per MetricKit).
// Skipping a payload identical to the last one written for that observation
// leaves Realm exactly as rewriting it would have: the local-only fields
// mapApiToRealm carries over are carried over again, and a payload with
// different fields (a detail fetch after a list fetch) differs anyway.

interface RemoteObservation {
  uuid?: string;
}

// cyrb53: a fast, well-distributed 53-bit string hash, so the payloads
// themselves needn't be kept
const hashString = ( str: string ): number => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for ( let i = 0; i < str.length; i += 1 ) {
    const ch = str.charCodeAt( i );
    h1 = Math.imul( h1 ^ ch, 2654435761 );
    h2 = Math.imul( h2 ^ ch, 1597334677 );
  }
  h1 = Math.imul( h1 ^ ( h1 >>> 16 ), 2246822507 );
  h1 ^= Math.imul( h2 ^ ( h2 >>> 13 ), 3266489909 );
  h2 = Math.imul( h2 ^ ( h2 >>> 16 ), 2246822507 );
  h2 ^= Math.imul( h1 ^ ( h1 >>> 13 ), 3266489909 );
  return 4294967296 * ( 2097151 & h2 ) + ( h1 >>> 0 );
};

// Hash of the API payload each observation was last written from, by uuid
const lastWrittenHashes = new Map<string, number>( );

// Splits off the observations whose payload was the last one written for them
// (and which are still in Realm), and returns the rest with a function that
// records them as written. Call it only once their write has committed, so a
// failed write is retried in full next time.
const withoutUnchangedRemoteObservations = <T extends RemoteObservation>(
  remoteObservations: T[],
  realm: Realm,
): [T[], ( ) => void] => {
  const changed: [T, number][] = [];
  remoteObservations.forEach( obs => {
    const payloadHash = hashString( JSON.stringify( obs ) );
    const unchanged = !!obs.uuid
      && lastWrittenHashes.get( obs.uuid ) === payloadHash
      // Deleted locally since (e.g. signed out, or removed while offline)
      && !!realm.objectForPrimaryKey( "Observation", obs.uuid );
    if ( !unchanged ) changed.push( [obs, payloadHash] );
  } );
  // A caller's enclosing transaction could still be cancelled after the write
  const commitsItself = !realm.isInTransaction;
  const markWritten = ( ) => {
    if ( !commitsItself ) return;
    changed.forEach( ( [obs, payloadHash] ) => {
      if ( obs.uuid ) lastWrittenHashes.set( obs.uuid, payloadHash );
    } );
  };
  return [changed.map( ( [obs] ) => obs ), markWritten];
};

export default withoutUnchangedRemoteObservations;
