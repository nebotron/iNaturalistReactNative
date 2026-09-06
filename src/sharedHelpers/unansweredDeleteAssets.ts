import { MMKV } from "react-native-mmkv";
import { basePhotoAssetId } from "sharedHelpers/appCreatedPhotoAssets";

// PhotoKit can take a deleteAssets transaction and never answer it: no
// confirmation, no completion handler, no library change, and the transaction
// left open in photolibraryd afterwards so every later write hangs too.
//
// A transaction is all or nothing, so one asset it will not answer for blocks
// every photo batched with it — permanently, because the next cleanup batches
// them together again. The Sep 6 log is exactly that: 1049 photos, six
// attempts across three builds and an iOS point update, nothing ever deleted.
// Chunking the batch didn't help, because the asset is in the first chunk: a
// transaction of 200 was left outstanding just as the transaction of 947 had
// been. Every batch that predates Sep 5 deleted in ~1.4s.
//
// Nothing PhotoKit exposes says which asset it is. The whole batch reports
// canDelete=1, sourceType userLibrary, notDeletable=0, and the deletability
// summary is clean. The only instrument that can tell them apart is the
// deletion itself, and each attempt costs the user a wedged photo library, so
// this narrows the search instead of repeating it: the assets of a transaction
// that never came back are the suspect set, each cleanup puts half of that set
// to the library, and whichever half is implicated becomes the new suspect set.
// 200 assets are down to one in eight cleanups, and the photos that aren't
// suspects delete normally the whole time.
//
// Once a single asset is proven — alone in a transaction that hung, or the last
// one standing after its every companion deleted — it is quarantined: left out
// of future transactions so it stops taking a thousand other photos down with
// it, and reported to the user as a photo the app can't delete.

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
};
