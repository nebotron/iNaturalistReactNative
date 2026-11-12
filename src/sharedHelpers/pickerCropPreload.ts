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
// while it is open, before anything is selected. When one of them is
// imported, aliasPreload (PhotoLibrary) hands its prepare to the imported copy.
export const PICKER_PRELOAD_COUNT = getTunable( "pickerPreloadCount" );

const exporter = ( ) => ( NativeModules as {
  ImageCropper?: {
    exportPHAsset?: ( phUri: string, destPath: string ) => Promise<unknown>;
  };
} ).ImageCropper?.exportPHAsset;

// Library photos started here and not yet handed to an import, by ph:// URI.
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

export const canPreloadPickerPhoto = ( uri: string ) => Platform.OS === "ios"
  && uri.startsWith( "ph://" )
  && !uri.startsWith( "ph:///" )
  && !!exporter( );

// The export is of the asset's original bytes (exportPHAsset), the same file
// the import copies, not the edited version a crop-source export reads: a
// photo edited in Photos can differ in size and framing from its original, and
// the prepare has to describe the file that is finally cropped.
export function preloadPickerPhoto( phUri: string, filename?: string | null ) {
  const exportPHAsset = exporter( );
  if ( !exportPHAsset || !canPreloadPickerPhoto( phUri ) || pickerPreloads.has( phUri ) ) {
    return;
  }
  pickerPreloads.add( phUri );
  const destPath = scratchPathFor( phUri, filename );
  enqueuePreload( phUri, phUri, null, async ( ) => {
    await mkdir( cropSourcesPath );
    await exportPHAsset( phUri, destPath );
    return `file://${destPath}`;
  } ).catch( ( ) => null );
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
