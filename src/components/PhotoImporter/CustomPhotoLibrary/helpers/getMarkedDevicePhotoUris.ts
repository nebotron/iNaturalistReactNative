import type Realm from "realm";
import {
  getPreviouslyUploadedDevicePhotoUrisSet,
} from "sharedHelpers/duplicateUploadedDevicePhotos";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import useStore from "stores/useStore";

const getMarkedDevicePhotoUris = ( realm: Realm ): Set<string> => {
  const markedUris = getPreviouslyUploadedDevicePhotoUrisSet( realm );
  const { originalDevicePhotoUris } = useStore.getState( );

  originalDevicePhotoUris.forEach( uri => {
    const normalizedUri = normalizeDevicePhotoUri( uri );
    if ( normalizedUri ) {
      markedUris.add( normalizedUri );
    }
  } );

  return markedUris;
};

export default getMarkedDevicePhotoUris;
