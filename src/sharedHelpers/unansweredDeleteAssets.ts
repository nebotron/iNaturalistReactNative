import { MMKV } from "react-native-mmkv";
import { basePhotoAssetId } from "sharedHelpers/appCreatedPhotoAssets";

// PhotoKit can take a deleteAssets transaction and never answer it: no
// confirmation, no completion handler, no library change, and the transaction
// left open in photolibraryd afterwards so every later write hangs too.
//
// The log settled that it is deleteAssets that hangs, not any asset in it: two
// disjoint sets both hung, as did transactions of one asset and of 932, and the
// same photos deleted normally minutes later. So this module only tracks the
// open transaction and the transaction size the device will take.

const store = new MMKV( { id: "unanswered-delete-assets" } );

// The assets of the transaction currently open, and the largest transaction the
// same cleanup had already had answered. Written before performChanges is asked
// for and cleared when it answers, so a record still here on the next launch is
// a transaction that never came back — which is the one thing a callback that
// never fires cannot tell us. The size alongside it is what says whether that
// means anything: see takeUnansweredTransaction.
const IN_FLIGHT_KEY = "inFlight";
// The largest transaction this device has been willing to answer lately.
const CAP_KEY = "maxTransactionSize";

// The biggest transaction a cleanup will ask for, and where the cap starts.
export const MAX_TRANSACTION_SIZE = 200;

// The smallest it may shrink to.
//
// Every transaction costs the user one system consent alert, whatever it
// carries, so the batch size is really the number of times a cleanup asks
// permission. That is what made the cap a trap: the cap halved on every
// transaction "the library never answered", but an unanswered transaction is
// an alert nobody tapped, and the smaller the cap got the more alerts a cleanup
// needed, so fewer were answered and the cap halved again. It went
// 200 → 156 → 78 → 39 → 25 → 1 over two days, and at one photo per alert the
// Sep 21 log has the user approving fifty in a row and then declining — which
// the app recorded as further proof that the library was broken.
//
// Below this a cleanup asks more times than anyone will answer, so shrinking
// past it can only manufacture the evidence that shrank it.
export const MIN_TRANSACTION_SIZE = 100;

// How many assets this device will currently take in one transaction.
//
// Every transaction attempted since deletions stopped working has been 166,
// 200, 932 or 947 assets, and every one was left unanswered. Nothing smaller
// has ever been tried: each attempt at chunking put a big chunk first, so the
// small ones behind it were never reached. Whether PhotoKit will still answer a
// transaction of five is simply unknown, and it is the last thing about the
// request itself that has not been ruled out.
//
// So the cap moves with the evidence, between the floor and the ceiling above.
// A transaction the library genuinely refuses halves it; one it answers at the
// cap doubles it back up. Caps stored before the floor existed are clamped on
// the way out, so a device sitting at 1 recovers on its next cleanup instead of
// asking three hundred times.
export const maxTransactionSize = ( ): number => Math.min(
  MAX_TRANSACTION_SIZE,
  Math.max( MIN_TRANSACTION_SIZE, store.getNumber( CAP_KEY ) || MAX_TRANSACTION_SIZE ),
);

// PhotoKit refused a transaction of this size, so ask for half as much — but
// never so little that the cleanup needs more consent alerts than a person will
// sit through. Only called for a refusal the library actually made: a
// transaction left waiting on an alert says nothing about size.
export const recordUnansweredSize = ( size: number ) => store.set(
  CAP_KEY,
  Math.max( MIN_TRANSACTION_SIZE, Math.floor( size / 2 ) ),
);

// It answered one. Only a transaction that filled the cap says anything about
// raising it — the small ones at the head of every cleanup always come back.
export const recordAnsweredSize = ( size: number ) => {
  const cap = maxTransactionSize( );
  if ( size < cap ) return;
  store.set( CAP_KEY, Math.min( MAX_TRANSACTION_SIZE, cap * 2 ) );
};

// Called before a transaction is asked for, so that a transaction which never
// answers is still identifiable after the app is killed and relaunched.
// answeredMax is the largest transaction this cleanup has already had answered.
export const beginDeleteTransaction = ( uris: string[], answeredMax = 0 ) => store.set(
  IN_FLIGHT_KEY,
  JSON.stringify( { ids: uris.map( basePhotoAssetId ), answeredMax } ),
);

export const endDeleteTransaction = ( ) => store.delete( IN_FLIGHT_KEY );

// Records written before the size was kept carried the ids alone.
const readInFlight = ( ): { ids: string[]; answeredMax: number } => {
  const raw = store.getString( IN_FLIGHT_KEY );
  if ( !raw ) return { ids: [], answeredMax: 0 };
  try {
    const parsed = JSON.parse( raw );
    if ( Array.isArray( parsed ) ) {
      return {
        ids: parsed.filter( ( id ): id is string => typeof id === "string" ),
        answeredMax: 0,
      };
    }
    return {
      ids: Array.isArray( parsed?.ids )
        ? parsed.ids.filter( ( id: unknown ): id is string => typeof id === "string" )
        : [],
      answeredMax: typeof parsed?.answeredMax === "number"
        ? parsed.answeredMax
        : 0,
    };
  } catch {
    return { ids: [], answeredMax: 0 };
  }
};

// Reads and clears a transaction left open by a previous run. Returns what it
// found and whether it was taken as evidence, for the log.
//
// A record is only evidence when it is bigger than anything that same cleanup
// had already had answered. A run that was deleting transactions this size and
// then stopped leaving records is a process that died — the app killed in the
// background, the bundle reloaded, the user force-quitting a long cleanup — and
// reading it as a hang costs far more than ignoring it: it halves the cap on
// every launch. That is what happened here. The
// device ground its way down to a cap of one photo, each 382-photo cleanup then
// took seven minutes, every one of them was abandoned part-way, and the
// one-asset record each left behind held the cap at one for the next. A
// transaction PhotoKit really won't answer still gets recorded properly, by the
// native watchdog, while the app is alive to see it.
export const takeUnansweredTransaction = ( ): { ids: string[]; evidence: boolean } => {
  const { ids, answeredMax } = readInFlight( );
  if ( ids.length === 0 ) return { ids: [], evidence: false };
  store.delete( IN_FLIGHT_KEY );
  const evidence = ids.length > answeredMax;
  if ( evidence ) recordUnansweredSize( ids.length );
  return { ids, evidence };
};

// Test seam: MMKV persists across a test file otherwise. The cap is settable
// so a test can stand up a device whose stored cap collapsed under the old
// halving, which is what every phone that ran those builds is carrying.
export const forgetUnansweredDeleteState = ( cap = MAX_TRANSACTION_SIZE ) => {
  store.delete( IN_FLIGHT_KEY );
  store.set( CAP_KEY, cap );
};
