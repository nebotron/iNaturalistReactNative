import { usbImportPhotosPath } from "appConstants/paths";
import { NativeModules, Platform } from "react-native";
import { MMKV } from "react-native-mmkv";

// JS side of the UsbStorage native module (iOS): the user grants access to a
// folder once (e.g. a USB drive mounted in Files), then importNewUsbImages
// copies anything not yet imported into app storage with no further
// interaction. Which files have been imported is tracked here by their
// relative path on the drive, so unplugging and replugging doesn't re-import.

export interface UsbPhoto {
  name: string;
  uri: string;
  fileName: string;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  timestamp: number;
}

// Why a scan produced no photos, surfaced for diagnostics. "ok" means the drive
// was scanned; the other values are the early-return reasons in UsbStorage.m.
export type UsbImportReason =
  | "ok"
  | "no-folder-saved"
  | "access-denied"
  | "drive-disconnected";

export interface UsbImportResult {
  available: boolean;
  reason: UsbImportReason;
  photos: UsbPhoto[];
  // Present only when available (reason === "ok").
  regularFileCount?: number;
  imageFileCount?: number;
  alreadyImportedCount?: number;
  copyFailureCount?: number;
  // Added JS-side: how many relative paths are tracked as already imported.
  knownCount?: number;
}

interface UsbStorageModule {
  pickFolder: ( ) => Promise<string | null>;
  getFolderName: ( ) => Promise<string | null>;
  forgetFolder: ( ) => Promise<void>;
  importNewImages: (
    destDir: string,
    knownNames: string[],
    maxCount: number
  ) => Promise<UsbImportResult>;
}

const usbStorage = Platform.OS === "ios"
  ? ( NativeModules as { UsbStorage?: UsbStorageModule } ).UsbStorage
  : undefined;

const MAX_PHOTOS_PER_SCAN = 100;
const IMPORTED_NAMES_KEY = "importedNames";

const store = new MMKV( { id: "usb-import" } );

const getImportedNames = ( ): string[] => JSON.parse(
  store.getString( IMPORTED_NAMES_KEY ) ?? "[]",
);

export const isUsbImportSupported = ( ) => !!usbStorage;

export const pickUsbFolder = ( ) => usbStorage?.pickFolder( ) ?? Promise.resolve( null );

export const getUsbFolderName = ( ) => usbStorage?.getFolderName( ) ?? Promise.resolve( null );

export const forgetUsbFolder = async ( ) => {
  await usbStorage?.forgetFolder( );
  store.delete( IMPORTED_NAMES_KEY );
};

export const importNewUsbImages = async ( ): Promise<UsbImportResult> => {
  if ( !usbStorage ) {
    return { available: false, reason: "no-folder-saved", photos: [] };
  }
  const knownNames = getImportedNames( );
  const result = await usbStorage.importNewImages(
    usbImportPhotosPath,
    knownNames,
    MAX_PHOTOS_PER_SCAN,
  );
  const { photos } = result;
  if ( photos.length > 0 ) {
    store.set( IMPORTED_NAMES_KEY, JSON.stringify( [
      ...knownNames,
      ...photos.map( photo => photo.name ),
    ] ) );
  }
  // Surface how many paths we already consider imported: an unexpectedly large
  // count here explains a scan that finds files on the drive but imports none.
  return { ...result, knownCount: knownNames.length } as UsbImportResult;
};
