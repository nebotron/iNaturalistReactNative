import { Body4 } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, { useEffect, useState } from "react";
import type { PhotoCameraInfo as Info } from "sharedHelpers/photoCameraInfo";
import { readCameraInfo } from "sharedHelpers/photoCameraInfo";

interface Props {
  uri?: string | null;
}

// Camera, lens and exposure of the local copy of a photo, read from its EXIF.
const PhotoCameraInfo = ( { uri }: Props ) => {
  const [read, setRead] = useState<{ uri: string; info: Info | null } | null>( null );

  useEffect( ( ) => {
    if ( !uri ) return;
    readCameraInfo( uri ).then( info => setRead( { uri, info } ) );
  }, [uri] );

  // Only the current photo's info, never the previous one's while it loads.
  const info = read?.uri === uri
    ? read.info
    : null;
  if ( !info ) return null;
  const lines = [
    [info.camera, info.lens].filter( Boolean ).join( " · " ),
    info.settings,
  ].filter( Boolean );

  return (
    <View className="px-4 py-1" testID="MediaViewer.PhotoCameraInfo">
      {lines.map( line => (
        <Body4 key={line} className="text-white text-center" selectable>
          {line}
        </Body4>
      ) )}
    </View>
  );
};

export default PhotoCameraInfo;
