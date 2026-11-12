import findGroupedPhotoByDisplayUri
  from "components/SharedComponents/ImageCrop/findGroupedPhotoByDisplayUri";
import {
  groupCropResumeParams,
  isCroppable,
} from "components/SharedComponents/ImageCrop/groupCropResume";
import { InteractionManager } from "react-native";
import type { PreloadResult } from "sharedHelpers/imageCropPreload";
import { enqueuePreload, PRELOAD_LOOKAHEAD } from "sharedHelpers/imageCropPreload";
import type { GroupCropResume, GroupedPhoto } from "stores/createObservationFlowSlice";
import useStore from "stores/useStore";

// A Group Photos photo's preload, from the file a crop of it would be applied
// to (its untouched original once it has been cropped) and with its saved
// crop. Everything that prepares a Group Photos photo goes through here: the
// cropper's lookahead, a selection in the grid, and the keeper below.
export const preloadGroupedPhoto = (
  uri: string,
  groupedPhotos: GroupedPhoto[],
  options: { background?: boolean } = {},
): Promise<PreloadResult | null> => {
  const photo = findGroupedPhotoByDisplayUri( groupedPhotos, uri );
  return enqueuePreload(
    uri,
    photo?.image.cropOriginalUri || uri,
    photo?.image.crop ?? null,
    options,
  );
};

// The photo the current bulk crop is on and the PRELOAD_LOOKAHEAD after it,
// read from the crop's saved progress, so they are known (and prepared) with
// the cropper closed, or before it is resumed after a restart.
export const cropJobUris = (
  resume: GroupCropResume | null,
  groupedPhotos: GroupedPhoto[],
): string[] => {
  const found = groupCropResumeParams( resume, groupedPhotos );
  if ( !found?.params.imageUri ) return [];
  const { imageUri } = found.params;
  return [
    imageUri,
    ...found.remainingUris.filter( uri => uri !== imageUri ).slice( 0, PRELOAD_LOOKAHEAD ),
  ];
};

// The first PRELOAD_LOOKAHEAD photos in Group Photos still to be cropped, in
// grid order: the ones a bulk crop of the grid starts on.
export const groupPhotosFirstUris = ( groupedPhotos: GroupedPhoto[] ): string[] => groupedPhotos
  .flatMap( group => group.photos ?? [] )
  .filter( photo => !photo.pending && !photo.image.crop && isCroppable( photo ) )
  .slice( 0, PRELOAD_LOOKAHEAD )
  .map( photo => photo.image.uri );

const keep = ( groupedPhotos: GroupedPhoto[], resume: GroupCropResume | null ) => {
  // The crop in progress is what the user is waiting on next...
  cropJobUris( resume, groupedPhotos ).forEach( uri => {
    preloadGroupedPhoto( uri, groupedPhotos ).catch( ( ) => null );
  } );
  // ...and the grid's first photos only once nothing for that is queued.
  groupPhotosFirstUris( groupedPhotos ).forEach( uri => {
    preloadGroupedPhoto( uri, groupedPhotos, { background: true } ).catch( ( ) => null );
  } );
};

// Keeps both prepared for as long as the app runs: whenever a photo lands,
// is cropped or removed, or the crop advances. A preload already done, running
// or queued is reused, so re-running this on every change costs nothing, and
// each finished one is kept on disk across restarts (imageCropPreload). Starts
// once launch has settled. Returns a function that stops it.
export function startKeepingCropPreloads( ): ( ) => void {
  let unsubscribe = ( ) => {};
  const handle = InteractionManager.runAfterInteractions( ( ) => {
    const initial = useStore.getState( );
    keep( initial.groupedPhotos, initial.groupCropResume );
    unsubscribe = useStore.subscribe( ( state, prev ) => {
      if ( state.groupedPhotos === prev.groupedPhotos
        && state.groupCropResume === prev.groupCropResume ) return;
      keep( state.groupedPhotos, state.groupCropResume );
    } );
  } );
  return ( ) => {
    handle.cancel( );
    unsubscribe( );
  };
}
