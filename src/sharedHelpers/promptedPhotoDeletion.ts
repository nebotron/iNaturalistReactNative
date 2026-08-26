import { MMKV } from "react-native-mmkv";

// Whether PhotoKit still carries out deletions that need the user's
// confirmation on this device.
//
// It stopped on this one. Every prompted transaction in the app log through
// Aug 25 04:03 completed, in about a second each; every one since Aug 25 14:25
// has hung, including one carrying a single photo, and the same ten photos
// have now survived seven attempts, three relaunches and a device restart. The
// assets are ordinary (userLibrary, canPerformEditOperation:delete YES), the
// app is foreground-active with no modal in the way, and the app never even
// goes inactive — so iOS never presents the confirmation, never calls the
// completion handler, and never deletes anything.
//
// There is nothing the app can do about that. What it can stop doing is
// spending 150s of the user's time on each attempt and holding the Photos
// write gate shut for all of it, which is what breaks every *other*
// library write for the rest of the session. So count the hangs, and once
// there are enough of them stop issuing the transaction until one works.
const store = new MMKV( { id: "prompted-photo-deletion" } );

const HANGS_KEY = "consecutive-hangs";

// Two in a row, so one odd deletion doesn't switch prompted deleting off for a
// device where it works. The log's run is seven.
const HANG_LIMIT = 2;

export const promptedDeletionHangs = ( ): number => store.getNumber( HANGS_KEY ) ?? 0;

// Prompted deletion has hung often enough that the next attempt is not worth
// what it costs. Any success clears this, and the cleanup screen offers a way
// to clear it by hand.
export const isPromptedDeletionBroken = ( ): boolean => promptedDeletionHangs( ) >= HANG_LIMIT;

export const recordPromptedDeletionHang = ( ): number => {
  const hangs = promptedDeletionHangs( ) + 1;
  store.set( HANGS_KEY, hangs );
  return hangs;
};

// One prompted transaction came back, so whatever was wrong isn't any more.
export const recordPromptedDeletionSuccess = ( ) => store.set( HANGS_KEY, 0 );

export const clearPromptedDeletionHangs = ( ) => store.set( HANGS_KEY, 0 );
