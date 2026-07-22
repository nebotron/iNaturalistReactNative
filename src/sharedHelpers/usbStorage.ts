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

interface UsbStorageModule {
  pickFolder: ( ) => Promise<string | null>;
  getFolderName: ( ) => Promise<string | null>;
  forgetFolder: ( ) => Promise<void>;
  importNewImages: (
    destDir: string,
    knownNames: string[],
    maxCount: number
  ) => Promise<{ available: boolean; photos: UsbPhoto[] }>;
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

export const importNewUsbImages = async ( ): Promise<UsbPhoto[]> => {
  if ( !usbStorage ) return [];
  const { photos } = await usbStorage.importNewImages(
    usbImportPhotosPath,
    getImportedNames( ),
    MAX_PHOTOS_PER_SCAN,
  );
  if ( photos.length > 0 ) {
    store.set( IMPORTED_NAMES_KEY, JSON.stringify( [
      ...getImportedNames( ),
      ...photos.map( photo => photo.name ),
    ] ) );
  }
  return photos;
};
