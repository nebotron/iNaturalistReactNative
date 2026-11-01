import { RealmContext } from "providers/contexts";
import { useEffect, useMemo, useState } from "react";
import type { RealmObservation } from "realmModels/types";
import type { PhotoCameraInfo } from "sharedHelpers/photoCameraInfo";
import { readCameraInfo } from "sharedHelpers/photoCameraInfo";

const { useRealm } = RealmContext;

// Camera settings of an observation's first photo, from the local copy of the
// observation (iNaturalist strips EXIF from hosted photos, so only the user's
// own observations have any): saved when the photo was added, else read from
// the original in the photo library.
const useObsCameraInfo = ( uuid?: string, enabled = false ): PhotoCameraInfo | null => {
  const realm = useRealm( );
  const { stored, deviceUri } = useMemo( ( ) => {
    if ( !enabled || !uuid ) return { stored: null, deviceUri: null };
    const obsPhoto = realm.objectForPrimaryKey<RealmObservation>( "Observation", uuid )
      ?.observationPhotos?.[0];
    let info: PhotoCameraInfo | null = null;
    try {
      info = obsPhoto?.cameraInfo
        ? JSON.parse( obsPhoto.cameraInfo )
        : null;
    } catch {
      info = null;
    }
    return { stored: info, deviceUri: obsPhoto?.originalDevicePhotoUri ?? null };
  }, [enabled, realm, uuid] );
  const [read, setRead] = useState<{ uri: string; info: PhotoCameraInfo | null } | null>( null );

  useEffect( ( ) => {
    if ( stored || !deviceUri ) return;
    readCameraInfo( deviceUri ).then( info => setRead( { uri: deviceUri, info } ) );
  }, [stored, deviceUri] );

  return stored || ( read?.uri === deviceUri
    ? read.info
    : null );
};

export default useObsCameraInfo;
