import { mkdir } from "@dr.pogodin/react-native-fs";
import { cropSourcesPath } from "appConstants/paths";
import { NativeModules, Platform } from "react-native";
import { enqueuePreload } from "sharedHelpers/imageCropPreload";
import { getTunable } from "sharedHelpers/tunableParams";

// The first photo of a bulk crop can't be preloaded once Done is tapped: the
// cropper opens at once and waits for the photo's copy out of the library and
// then its whole prepare. So the photos the picker opens on are prepared
// before anything is picked: as a USB import lands them, when a batch is
// imported (both preloadNewestPickerPhotos), and while the picker is open.
// When one of them is imported, aliasPreload (PhotoLibrary) hands its prepare
// to the imported copy.
//
// They are queued in the background, behind anything a crop is waiting on,
// so they are never discarded to make way for one: Done promotes the picked
// ones, and the rest keep their prepares for a later batch. Their files are
// swept with the other crop sources at the next launch.
export const PICKER_PRELOAD_COUNT = getTunable( "pickerPreloadCount" );

const exporter = ( ) => ( NativeModules as {
  ImageCropper?: {
    exportPHAsset?: ( phUri: string, destPath: string ) => Promise<unknown>;
  };
} ).ImageCropper?.exportPHAsset;

const extensionOf = ( filename?: string | null ) => {
  const match = filename?.match( /\.[a-z0-9]+$/i );
  return match
    ? match[0].toLowerCase( )
    : ".jpg";
};

const scratchPathFor = ( phUri: string, filename?: string | null ) => {
  const id = phUri.replace( /^ph:\/\//, "" ).replace( /[^a-z0-9]/gi, "_" );
  return `${cropSourcesPath}/picker_${id}${extensionOf( filename )}`;
};

const isLibraryAsset = ( uri: string ) => uri.startsWith( "ph://" ) && !uri.startsWith( "ph:///" );

// A Photos library asset, or a staged SD card photo, which is already a file.
export const canPreloadPickerPhoto = ( uri: string ) => Platform.OS === "ios"
  && ( uri.startsWith( "file://" ) || ( isLibraryAsset( uri ) && !!exporter( ) ) );

// A library photo is exported from its original bytes (exportPHAsset), the
// same file the import copies, not the edited version a crop-source export
// reads: a photo edited in Photos can differ in size and framing from its
// original, and the prepare has to describe the file that is finally cropped.
export function preloadPickerPhoto( uri: string, filename?: string | null ) {
  if ( !canPreloadPickerPhoto( uri ) ) return;
  const exportPHAsset = exporter( );
  const exportSource = isLibraryAsset( uri ) && exportPHAsset
    ? async ( ) => {
      const destPath = scratchPathFor( uri, filename );
      await mkdir( cropSourcesPath );
      await exportPHAsset( uri, destPath );
      return `file://${destPath}`;
    }
    : undefined;
  enqueuePreload( uri, uri, null, { exportSource, background: true } ).catch( ( ) => null );
}
