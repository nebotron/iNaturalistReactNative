import { mkdir } from "@dr.pogodin/react-native-fs";
import { cropSourcesPath } from "appConstants/paths";
import { NativeModules, Platform } from "react-native";
import {
  dequeuePreload,
  enqueuePreload,
  existingPreload,
  releaseCropSource,
} from "sharedHelpers/imageCropPreload";
import { getTunable } from "sharedHelpers/tunableParams";

// The first photo of a bulk crop can't be preloaded once Done is tapped: the
// cropper opens at once and waits for the photo's copy out of the library and
// then its whole prepare. So the newest photos in the picker are prepared
// before anything is selected: while it is open, and before it is opened
// (preloadNewestPickerPhotos). When one of them is imported, aliasPreload
// (PhotoLibrary) hands its prepare to the imported copy.
export const PICKER_PRELOAD_COUNT = getTunable( "pickerPreloadCount" );

const exporter = ( ) => ( NativeModules as {
  ImageCropper?: {
    exportPHAsset?: ( phUri: string, destPath: string ) => Promise<unknown>;
  };
} ).ImageCropper?.exportPHAsset;

// Photos started here and not yet handed to an import, by the URI the picker
// knows them by.
const pickerPreloads = new Set<string>( );

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

// The export is of the asset's original bytes (exportPHAsset), the same file
// the import copies, not the edited version a crop-source export reads: a
// photo edited in Photos can differ in size and framing from its original, and
// the prepare has to describe the file that is finally cropped.
export function preloadPickerPhoto( uri: string, filename?: string | null ) {
  // A prepare something else started (a USB import's own lookahead) is left to
  // whoever started it, and not released with the picker's.
  if ( !canPreloadPickerPhoto( uri ) || pickerPreloads.has( uri ) || existingPreload( uri ) ) {
    return;
  }
  pickerPreloads.add( uri );
  const exportPHAsset = exporter( );
  const exportSource = isLibraryAsset( uri ) && exportPHAsset
    ? async ( ) => {
      const destPath = scratchPathFor( uri, filename );
      await mkdir( cropSourcesPath );
      await exportPHAsset( uri, destPath );
      return `file://${destPath}`;
    }
    : undefined;
  enqueuePreload( uri, uri, null, exportSource ).catch( ( ) => null );
}

// Done was tapped (or the picker closed): the photos being imported keep their
// prepares, and the rest are dropped -- queued ones before they start, so they
// don't hold up the photo the cropper is waiting on, and finished ones along
// with their files. One already running can't be stopped, so its files go
// when it lands.
export function releasePickerPreloads( keepUris: Set<string> = new Set( ) ) {
  [...pickerPreloads].forEach( uri => {
    pickerPreloads.delete( uri );
    if ( keepUris.has( uri ) ) return;
    dequeuePreload( uri );
    existingPreload( uri )?.then( result => {
      if ( result ) releaseCropSource( uri, [result.localUri, result.displayUri] );
    } ).catch( ( ) => null );
  } );
}
