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
// The largest transaction this device has been willing to answer lately.
const CAP_KEY = "maxTransactionSize";

// The biggest transaction a cleanup will ask for, and where the cap starts.
export const MAX_TRANSACTION_SIZE = 200;

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

// How many assets this device will currently take in one transaction.
//
// Every transaction attempted since deletions stopped working has been 166,
// 200, 932 or 947 assets, and every one was left unanswered. Nothing smaller
// has ever been tried: each attempt at chunking put a big chunk first, so the
// small ones behind it were never reached. Whether PhotoKit will still answer a
// transaction of five is simply unknown, and it is the last thing about the
// request itself that has not been ruled out.
//
// So the cap moves with the evidence. A transaction the library never answers
// halves it; one it answers at the cap doubles it back toward the ceiling. A
// cleanup that hangs at 200 therefore comes back at 100, and one that hangs at
// 100 comes back at 50, until either the deletions start landing or the cap
// reaches one asset and the question is finally settled.
export const maxTransactionSize = ( ): number => (
  store.getNumber( CAP_KEY ) || MAX_TRANSACTION_SIZE
);

// PhotoKit never answered a transaction of this size, so ask for half as much.
export const recordUnansweredSize = ( size: number ) => store.set(
  CAP_KEY,
  Math.max( 1, Math.floor( size / 2 ) ),
);

// It answered one. Only a transaction that filled the cap says anything about
// raising it — the small ones at the head of every cleanup always come back.
export const recordAnsweredSize = ( size: number ) => {
  const cap = maxTransactionSize( );
  if ( size < cap ) return;
  store.set( CAP_KEY, Math.min( MAX_TRANSACTION_SIZE, cap * 2 ) );
};

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

// A transaction that never came back. Its assets are where an unanswerable one
// would be, and its size is more than this device will currently take.
//
// A single asset is only proven when it was sent alone deliberately, as the
// probe narrowing a suspect set that already contained it. Every cleanup now
// opens with a transaction of one to find the size the library will still
// answer, and quarantining that photo whenever the run failed would accuse a
// different innocent one each time. Sent alone as a probe it has hung twice,
// once in the set that put it under suspicion and once on its own, which is
// evidence about the asset rather than about the size.
export const recordUnansweredTransaction = (
  ids: string[],
  fromSuspectProbe = false,
) => {
  if ( ids.length === 0 ) return;
  if ( fromSuspectProbe && ids.length === 1 ) {
    // The asset is the explanation, so the size isn't. Halving the cap here
    // would punish every later cleanup for one bad photo.
    quarantine( ids[0] );
    return;
  }
  recordUnansweredSize( ids.length );
  write( SUSPECTS_KEY, ids );
};

// Reads and clears a transaction left open by a previous run, folding it into
// the suspect set. Returns what it found, for the log.
//
// Never treated as a probe: the record doesn't say which it was, and accusing
// an asset needs to be certain of that.
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

// How the suspect set goes out: never in one transaction, because one carrying
// all of it just hangs again and tells us nothing we don't know — but all of
// it, in halving transactions, one after another.
//
// This used to be a single transaction of half the set, and the other half was
// simply left out of the cleanup. That silently kept photos out of a delete the
// user had asked for: the Sep 9 log has a cleanup of 1454 photos where 25 were
// suspect, 13 went out, every transaction answered, and 12 photos were left in
// the library with the screen reporting a clean "Deleted 1442 photos". Halving
// chunks narrow exactly as well — the loop stops at the first one the library
// doesn't answer, and that chunk becomes the new suspect set — while a run in
// which nothing hangs empties the set and deletes the whole list.
export const suspectProbeChunks = ( suspect: string[], cap: number ): string[][] => {
  const ceiling = Math.max( 1, cap );
  const chunks: string[][] = [];
  let start = 0;
  while ( start < suspect.length ) {
    const size = Math.max( 1, Math.min( Math.ceil( ( suspect.length - start ) / 2 ), ceiling ) );
    chunks.push( suspect.slice( start, start + size ) );
    start += size;
  }
  return chunks;
};

// Test seam: MMKV persists across a test file otherwise.
export const forgetUnansweredDeleteState = ( ) => {
  write( IN_FLIGHT_KEY, [] );
  write( SUSPECTS_KEY, [] );
  write( QUARANTINED_KEY, [] );
  store.set( CAP_KEY, MAX_TRANSACTION_SIZE );
};
