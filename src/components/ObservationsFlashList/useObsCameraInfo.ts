import { RealmContext } from "providers/contexts";
import { useEffect, useMemo, useState } from "react";
import type { RealmObservation } from "realmModels/types";
import {
  libraryOriginalQuery, readLibraryCameraInfo,
} from "sharedHelpers/findLibraryOriginal";
import type { PhotoCameraInfo } from "sharedHelpers/photoCameraInfo";

const { useRealm } = RealmContext;

// Camera settings of an observation's first photo, from the local copy of the
// observation (iNaturalist strips EXIF from hosted photos, so only the user's
// own observations have any): saved when the photo was added, else read from
// the original in the photo library, or the library photo matched to it.
const useObsCameraInfo = ( uuid?: string, enabled = false ): PhotoCameraInfo | null => {
  const realm = useRealm( );
  const { stored, library } = useMemo( ( ) => {
    if ( !enabled || !uuid ) return { stored: null, library: null };
    const observation = realm.objectForPrimaryKey<RealmObservation>( "Observation", uuid );
    const obsPhoto = observation?.observationPhotos?.[0];
    let info: PhotoCameraInfo | null = null;
    try {
      info = obsPhoto?.cameraInfo
        ? JSON.parse( obsPhoto.cameraInfo )
        : null;
    } catch {
      info = null;
    }
    return {
      stored: info,
      library: observation && obsPhoto
        ? libraryOriginalQuery( obsPhoto, observation )
        : null,
    };
  }, [enabled, realm, uuid] );
  const [read, setRead] = useState<{ uuid?: string; info: PhotoCameraInfo | null } | null>( null );

  useEffect( ( ) => {
    if ( stored || !library ) return;
    readLibraryCameraInfo( library ).then( info => setRead( { uuid, info } ) );
  }, [stored, library, uuid] );

  return stored || ( read?.uuid === uuid
    ? read.info
    : null );
};

export default useObsCameraInfo;
