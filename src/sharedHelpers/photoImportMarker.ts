import { MMKV } from "react-native-mmkv";

// A breadcrumb that outlives the process, so a gallery import the app never
// came back from can be reported on the next launch.
//
// `photo_import_stalled` fires once, 30s in, and says how far the import had
// got by then — but it cannot say what happened afterwards. The Aug 6 log has
// an import of 48 photos that logged the tap, reported 9 of 48 settled at 30s,
// rejected six exports on the no-progress watchdog at 134s, and then nothing:
// no "settled" line, no further stall, and a cold pickup twelve minutes later.
// That is either an import still wedged or an app that died holding it, and
// every log line is a network POST, so a run that dies takes its last lines
// with it. These are MMKV writes, not log lines: they survive the death that
// is the thing being measured. Same pattern as the USB offload's marker
// (usbStorage.ts), which settled the same question there.
const store = new MMKV( { id: "photo-import" } );

const IMPORT_IN_PROGRESS_KEY = "importInProgress";

export interface PhotoImportMarker {
  selected: number;
  settled: number;
  failed: number;
  startedAt: number;
}

export const markPhotoImportStarted = ( selected: number ) => {
  store.set( IMPORT_IN_PROGRESS_KEY, JSON.stringify( {
    selected,
    settled: 0,
    failed: 0,
    startedAt: Date.now( ),
  } ) );
};

export const updatePhotoImportProgress = ( settled: number, failed: number ) => {
  const raw = store.getString( IMPORT_IN_PROGRESS_KEY );
  if ( !raw ) return;
  store.set( IMPORT_IN_PROGRESS_KEY, JSON.stringify( {
    ...JSON.parse( raw ),
    settled,
    failed,
  } ) );
};

export const clearPhotoImportMarker = ( ) => store.delete( IMPORT_IN_PROGRESS_KEY );

// The marker left by an import that never finished, or null. Reading it clears
// it, so one abandoned import is reported once.
export const takeUnfinishedPhotoImport = ( ): PhotoImportMarker | null => {
  const raw = store.getString( IMPORT_IN_PROGRESS_KEY );
  if ( !raw ) return null;
  store.delete( IMPORT_IN_PROGRESS_KEY );
  try {
    return JSON.parse( raw ) as PhotoImportMarker;
  } catch {
    return null;
  }
};
