import {
  Body3, Body4, BottomSheet,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React, { useEffect, useState } from "react";
import type { PhotoCameraInfo as Info } from "sharedHelpers/photoCameraInfo";
import { readCameraInfo } from "sharedHelpers/photoCameraInfo";
import { useTranslation } from "sharedHooks";

interface Props {
  uri?: string | null;
}

// Camera, lens, exposure and focus distance of the local copy of a photo, read
// from its EXIF. Tapping the summary shows every value in a table.
const PhotoCameraInfo = ( { uri }: Props ) => {
  const { t } = useTranslation( );
  const [read, setRead] = useState<{ uri: string; info: Info | null } | null>( null );
  const [showTable, setShowTable] = useState( false );

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
    [info.focalLength, info.aperture, info.shutterSpeed, info.iso && `ISO ${info.iso}`]
      .filter( Boolean ).join( " · " ),
  ].filter( Boolean );
  const rows = [
    [t( "Camera" ), info.camera],
    [t( "Lens" ), info.lens],
    [t( "Focal-length" ), info.focalLength],
    [t( "Aperture" ), info.aperture],
    [t( "Shutter-speed" ), info.shutterSpeed],
    [t( "ISO" ), info.iso],
    [t( "Focus-distance" ), info.focusDistance],
  ].filter( ( [, value] ) => value );

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityHint={t( "Shows-the-camera-settings-of-this-photo" )}
        className="px-4 py-1"
        testID="MediaViewer.PhotoCameraInfo"
        onPress={( ) => setShowTable( true )}
      >
        {lines.map( line => (
          <Body4 key={line} className="text-white text-center">
            {line}
          </Body4>
        ) )}
      </Pressable>
      {showTable && (
        <BottomSheet
          headerText={t( "Camera-settings" )}
          onPressClose={( ) => setShowTable( false )}
          insideModal
        >
          <View className="p-5">
            {rows.map( ( [label, value] ) => (
              <View
                key={label}
                className="flex-row justify-between py-2 border-b border-lightGray"
              >
                <Body3 className="font-bold mr-4">{label}</Body3>
                <Body3 className="flex-1 text-right" selectable>{value}</Body3>
              </View>
            ) )}
          </View>
        </BottomSheet>
      )}
    </>
  );
};

export default PhotoCameraInfo;
