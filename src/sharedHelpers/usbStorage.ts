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

export const saveUsbImageToPhotos = ( relativePath: string ) => (
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
