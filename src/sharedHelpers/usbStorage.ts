import { NativeModules, Platform } from "react-native";
import { MMKV } from "react-native-mmkv";

// JS side of the UsbStorage native module (iOS): the user grants access to a
// folder once (e.g. a USB drive mounted in Files), then the offload flow lists
// not-yet-imported images (listNewUsbImages), saves each into the Photos
// library (saveUsbImageToPhotos), and once the whole batch is saved, deletes
// them from the source (deleteUsbSourceImages). Which files have been imported
// is tracked here by their relative path on the drive, so a failed delete
// doesn't cause a re-import.

export interface UsbImageRef {
  relativePath: string;
  fileSize: number | null;
}

// Why a list produced no images, surfaced for diagnostics. "ok" means the drive
// was scanned; the other values are the early-return reasons in UsbStorage.m.
export type UsbImportReason =
  | "ok"
  | "no-folder-saved"
  | "access-denied"
  | "drive-disconnected";

export interface UsbListResult {
  available: boolean;
  reason: UsbImportReason;
  images: UsbImageRef[];
  // Present only when available (reason === "ok").
  regularFileCount?: number;
  imageFileCount?: number;
  alreadyImportedCount?: number;
  // Histogram of lowercased file extensions seen on the drive, e.g.
  // { cr3: 53 }. Explains a scan that recognizes no images.
  extensions?: Record<string, number>;
  // Added JS-side: how many relative paths are tracked as already imported.
  knownCount?: number;
}

export interface UsbDeleteResult {
  deleted: number;
  failed: number;
  available?: boolean;
}

export interface UsbFolderDiagnostics {
  bookmarkPresent: boolean;
  resolved: boolean;
  stale: boolean;
  reachable: boolean;
  bookmarkBytes?: number;
}

export type PhotosPermissionStatus =
  | "authorized"
  | "limited"
  | "denied"
  | "restricted"
  | "notDetermined";

interface UsbStorageModule {
  pickFolder: ( ) => Promise<string | null>;
  getFolderName: ( ) => Promise<string | null>;
  getFolderDiagnostics: ( ) => Promise<UsbFolderDiagnostics>;
  forgetFolder: ( ) => Promise<void>;
  requestPhotosPermission: ( ) => Promise<PhotosPermissionStatus>;
  listNewImages: (
    knownNames: string[],
    maxCount: number
  ) => Promise<UsbListResult>;
  saveImageToPhotos: ( relativePath: string ) => Promise<{ saved: boolean }>;
  deleteSourceImages: ( relativePaths: string[] ) => Promise<UsbDeleteResult>;
}

const usbStorage = Platform.OS === "ios"
  ? ( NativeModules as { UsbStorage?: UsbStorageModule } ).UsbStorage
  : undefined;

// How many images to offload per scan. We no longer bulk-copy up front, so this
// can be generous; anything beyond it is handled by the next scan (the batch
// just processed is deleted from the card first).
const MAX_PHOTOS_PER_SCAN = 500;
const IMPORTED_NAMES_KEY = "importedNames";

const store = new MMKV( { id: "usb-import" } );

const getImportedNames = ( ): string[] => JSON.parse(
  store.getString( IMPORTED_NAMES_KEY ) ?? "[]",
);

export const isUsbImportSupported = ( ) => !!usbStorage;

export const pickUsbFolder = ( ) => usbStorage?.pickFolder( ) ?? Promise.resolve( null );

export const getUsbFolderName = ( ) => usbStorage?.getFolderName( ) ?? Promise.resolve( null );

export const getUsbFolderDiagnostics = ( ): Promise<UsbFolderDiagnostics> => (
  usbStorage?.getFolderDiagnostics( )
  ?? Promise.resolve( {
    bookmarkPresent: false, resolved: false, stale: false, reachable: false,
  } )
);

export const forgetUsbFolder = async ( ) => {
  await usbStorage?.forgetFolder( );
  store.delete( IMPORTED_NAMES_KEY );
};

export const requestUsbPhotosPermission = ( ): Promise<PhotosPermissionStatus> => (
  usbStorage?.requestPhotosPermission( ) ?? Promise.resolve( "denied" )
);

export const listNewUsbImages = async ( ): Promise<UsbListResult> => {
  if ( !usbStorage ) {
    return { available: false, reason: "no-folder-saved", images: [] };
  }
  const knownNames = getImportedNames( );
  const result = await usbStorage.listNewImages( knownNames, MAX_PHOTOS_PER_SCAN );
  return { ...result, knownCount: knownNames.length };
};

// Resolves with the identifier of the asset created in the Photos library, so
// the caller can record it as ours (appCreatedPhotoAssets.ts) — an asset the
// app created is the one thing PhotoKit will delete without a confirmation.
export const saveUsbImageToPhotos = ( relativePath: string ): Promise<{
  saved: boolean;
  localIdentifier?: string;
}> => (
  usbStorage?.saveImageToPhotos( relativePath ) ?? Promise.resolve( { saved: false } )
);

export const deleteUsbSourceImages = ( relativePaths: string[] ): Promise<UsbDeleteResult> => (
  usbStorage?.deleteSourceImages( relativePaths )
  ?? Promise.resolve( { deleted: 0, failed: relativePaths.length } )
);

// Track saved files as imported so a later delete failure (or an unplug before
// deletion) doesn't cause them to be saved to Photos a second time.
export const markUsbImagesImported = ( relativePaths: string[] ) => {
  if ( relativePaths.length === 0 ) return;
  store.set( IMPORTED_NAMES_KEY, JSON.stringify( [
    ...getImportedNames( ),
    ...relativePaths,
  ] ) );
};

// A breadcrumb that outlives the process, so an offload the app never came
// back from can be reported on the next launch.
//
// The Aug 5 19:08–20:22 log has two offloads of the same 80 files, each
// followed within a minute by a cold `pickup` and neither followed by an
// outcome line, and the session before it had two more that "ended with the
// app being killed before the outcome line". Every line in the log is a
// network POST, so a run that dies takes its last lines with it and nothing
// says how far it got. These are MMKV writes, not log lines: no POST, and
// they survive the death that is the thing being measured.
const OFFLOAD_IN_PROGRESS_KEY = "offloadInProgress";

export interface UsbOffloadMarker {
  total: number;
  saved: number;
  failed: number;
  startedAt: number;
  // What the run was doing when it last touched the marker, and when. A run
  // that never finished is either stuck in a native call or was suspended by
  // iOS mid-loop, and startedAt alone can't tell those apart: both look like a
  // marker left behind hours ago. The Aug 12 run reported 4h9m of "msRunning"
  // with one file failed and nothing else said.
  phase?: string;
  lastProgressAt?: number;
  // AppState at the last update. A wedged native call leaves the app active;
  // iOS freezing the JS thread only happens in the background.
  appState?: string;
}

export const markUsbOffloadStarted = ( total: number ) => {
  store.set( OFFLOAD_IN_PROGRESS_KEY, JSON.stringify( {
    total,
    saved: 0,
    failed: 0,
    startedAt: Date.now( ),
    lastProgressAt: Date.now( ),
    phase: "starting",
  } ) );
};

export const updateUsbOffloadProgress = (
  saved: number,
  failed: number,
  phase?: string,
  appState?: string,
) => {
  const raw = store.getString( OFFLOAD_IN_PROGRESS_KEY );
  if ( !raw ) return;
  store.set( OFFLOAD_IN_PROGRESS_KEY, JSON.stringify( {
    ...JSON.parse( raw ),
    saved,
    failed,
    lastProgressAt: Date.now( ),
    ...( phase
      ? { phase }
      : {} ),
    ...( appState
      ? { appState }
      : {} ),
  } ) );
};

export const clearUsbOffloadMarker = ( ) => store.delete( OFFLOAD_IN_PROGRESS_KEY );

// The marker left by an offload that never finished, or null. Reading it
// clears it, so one abandoned run is reported once.
export const takeUnfinishedUsbOffload = ( ): UsbOffloadMarker | null => {
  const raw = store.getString( OFFLOAD_IN_PROGRESS_KEY );
  if ( !raw ) return null;
  store.delete( OFFLOAD_IN_PROGRESS_KEY );
  try {
    return JSON.parse( raw ) as UsbOffloadMarker;
  } catch {
    return null;
  }
};
