import { MMKV } from "react-native-mmkv";
import { basePhotoAssetId } from "sharedHelpers/appCreatedPhotoAssets";

// PhotoKit can take a deleteAssets transaction and never answer it: no
// confirmation, no completion handler, no library change, and the transaction
// left open in photolibraryd afterwards so every later write hangs too.
//
// This module exists to tell two different failures apart, and the log has now
// settled which one this is. If a single asset were unanswerable it would take
// every photo batched with it down, permanently, because the next cleanup
// batches them together again — so the assets of a transaction that never came
// back become the suspect set, each cleanup puts half of that set to the
// library, and whichever half is implicated becomes the new suspect set, until
// one asset is alone in a transaction that hangs and can be quarantined.
//
// That search ran and came back empty. Two disjoint sets both hung, and so did
// a transaction of one asset, of 166, of 200, of 932 — twelve in a row across
// five builds since Sep 5, with a no-op modify transaction answering in 37ms in
// between. It is deleteAssets that is broken on the device, not any asset in
// it. So the streak below is what the module is mostly for now: knowing when to
// stop asking. The narrowing stays because it costs nothing while deletions are
// working, and it is the only thing that could tell us if this ever does come
// down to one bad photo.

const store = new MMKV( { id: "unanswered-delete-assets" } );

// The assets of the transaction currently open. Written before performChanges
// is asked for and cleared when it answers, so a record still here on the next
// launch is a transaction that never came back — which is the one thing a
// callback that never fires cannot tell us.
const IN_FLIGHT_KEY = "inFlight";
// Assets known to include one PhotoKit will not answer for.
const SUSPECTS_KEY = "suspects";
// Assets proven, one at a time, to be that.
const QUARANTINED_KEY = "quarantined";
// How many transactions in a row PhotoKit has left unanswered.
const STREAK_KEY = "unansweredStreak";

// Past this, deleting is not something this device can currently do, and asking
// it again is not a retry — it is 150 seconds of the user's time and then half
// an hour with a photo library that refuses every write, for nothing. The Sep 4
// to Sep 9 log is twelve unanswered transactions in a row across five builds,
// of 1, 166, 200, 932 and 947 assets, with a no-op modify answering in 37ms
// between two of them: it is deleteAssets specifically, and nothing about what
// is in it has changed the outcome once.
//
// Three rather than one because a single unanswered transaction has always
// been recoverable before, and because two of the twelve were the app's own
// doing — one issued as the bundle reloaded under it, one stacked on a
// transaction already open.
const UNANSWERED_STREAK_LIMIT = 3;

const read = ( key: string ): string[] => {
  const raw = store.getString( key );
  if ( !raw ) return [];
  try {
    const parsed = JSON.parse( raw );
    return Array.isArray( parsed )
      ? parsed.filter( ( id ): id is string => typeof id === "string" )
      : [];
  } catch {
    return [];
  }
};

const write = ( key: string, ids: string[] ) => store.set( key, JSON.stringify( ids ) );

// How many transactions PhotoKit has left unanswered since the last one it
// answered.
export const unansweredStreak = ( ): number => store.getNumber( STREAK_KEY ) ?? 0;

// Whether deleting is something this device is currently doing at all. When it
// isn't, a cleanup says so instead of spending the user's afternoon proving it
// again.
export const deletesAreUnanswered = ( ): boolean => (
  unansweredStreak( ) >= UNANSWERED_STREAK_LIMIT
);

// The user asking to try anyway, or a transaction that came back. Either way
// the evidence for giving up is gone.
export const clearUnansweredStreak = ( ) => store.set( STREAK_KEY, 0 );

export const quarantinedAssetIds = ( ): string[] => read( QUARANTINED_KEY );

export const suspectAssetIds = ( ): string[] => read( SUSPECTS_KEY );

const quarantine = ( id: string ) => {
  const quarantined = read( QUARANTINED_KEY );
  if ( !quarantined.includes( id ) ) {
    write( QUARANTINED_KEY, [...quarantined, id] );
  }
  write( SUSPECTS_KEY, [] );
};

// Called before a transaction is asked for, so that a transaction which never
// answers is still identifiable after the app is killed and relaunched.
export const beginDeleteTransaction = ( uris: string[] ) => write(
  IN_FLIGHT_KEY,
  uris.map( basePhotoAssetId ),
);

export const endDeleteTransaction = ( ) => write( IN_FLIGHT_KEY, [] );

// A transaction that never came back. Its assets are where the unanswerable one
// is; when it carried only one, that one is proven.
export const recordUnansweredTransaction = ( ids: string[] ) => {
  if ( ids.length === 0 ) return;
  store.set( STREAK_KEY, unansweredStreak( ) + 1 );
  if ( ids.length === 1 ) {
    quarantine( ids[0] );
    return;
  }
  write( SUSPECTS_KEY, ids );
};

// Reads and clears a transaction left open by a previous run, folding it into
// the suspect set. Returns what it found, for the log.
export const takeUnansweredTransaction = ( ): string[] => {
  const inFlight = read( IN_FLIGHT_KEY );
  if ( inFlight.length === 0 ) return [];
  write( IN_FLIGHT_KEY, [] );
  recordUnansweredTransaction( inFlight );
  return inFlight;
};

// Half of the suspect set deleted normally, so if there is an asset PhotoKit
// won't answer for, it is in the half that didn't go out. Narrows to that half.
//
// Deliberately does not conclude anything when that leaves a single asset.
// Quarantining the last one standing would be an inference from the set
// containing a bad asset at all, and it need not: a transaction can be recorded
// unanswered while it is merely slow and still lands later, and a suspect set
// built from one of those contains nothing wrong. Left as the suspect set, that
// asset goes out alone in the next cleanup and either hangs — which quarantines
// it on its own evidence — or deletes, which empties the set and ends the
// search with nothing accused.
export const recordAnsweredSuspects = ( ids: string[] ) => {
  const answered = new Set( ids );
  write( SUSPECTS_KEY, read( SUSPECTS_KEY ).filter( id => !answered.has( id ) ) );
};

// Everything the app knows it must not put in a transaction, and the set it is
// still narrowing. Both are base ids, matched against a uri with
// basePhotoAssetId.
export const partitionForDelete = ( uris: string[] ) => {
  const quarantined = new Set( quarantinedAssetIds( ) );
  const suspects = new Set( suspectAssetIds( ) );
  const skipped: string[] = [];
  const suspect: string[] = [];
  const ordinary: string[] = [];
  uris.forEach( uri => {
    const id = basePhotoAssetId( uri );
    if ( quarantined.has( id ) ) skipped.push( uri );
    else if ( suspects.has( id ) ) suspect.push( uri );
    else ordinary.push( uri );
  } );
  return { skipped, suspect, ordinary };
};

// Only what a cleanup would put to PhotoKit this time: the whole suspect set is
// never sent at once, because a transaction carrying all of it just hangs
// again and tells us nothing we don't know.
export const suspectProbe = ( suspect: string[] ): string[] => (
  suspect.length === 0
    ? []
    : suspect.slice( 0, Math.ceil( suspect.length / 2 ) )
);

// Test seam: MMKV persists across a test file otherwise.
export const forgetUnansweredDeleteState = ( ) => {
  write( IN_FLIGHT_KEY, [] );
  write( SUSPECTS_KEY, [] );
  write( QUARANTINED_KEY, [] );
  clearUnansweredStreak( );
};
