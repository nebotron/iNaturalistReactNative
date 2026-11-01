import {
  Body3, Body4, BottomSheet,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useEffect, useMemo, useState } from "react";
import type { RealmObservation } from "realmModels/types";
import type { PhotoCameraInfo as Info } from "sharedHelpers/photoCameraInfo";
import { readCameraInfo } from "sharedHelpers/photoCameraInfo";
import { useTranslation } from "sharedHooks";

const { useRealm } = RealmContext;

interface Props {
  uri?: string | null;
  url?: string | null;
}

// Camera, lens, exposure and focus distance saved when the photo was added, else
// read from the EXIF of the local copy, falling back to the original in the photo library for
// uploaded photos (iNaturalist strips EXIF from the copies it hosts). Tapping
// the summary shows every value in a table.
const PhotoCameraInfo = ( { uri, url }: Props ) => {
  const { t } = useTranslation( );
  const realm = useRealm( );
  const [read, setRead] = useState<{ key: string; info: Info | null } | null>( null );
  const [showTable, setShowTable] = useState( false );

  const { deviceUri, stored } = useMemo( ( ) => {
    const query = url
      ? ["ANY observationPhotos.photo.url == $0", url]
      : uri && ["ANY observationPhotos.photo.localFilePath ENDSWITH $0", uri.split( "/" ).pop( )];
    if ( !query ) return { deviceUri: null, stored: null };
    const observation = realm.objects<RealmObservation>( "Observation" )
      .filtered( query[0], query[1] )[0];
    const obsPhoto = observation?.observationPhotos?.find( op => ( url
      ? op.photo?.url === url
      : op.photo?.localFilePath?.endsWith( query[1] as string ) ) );
    let storedInfo: Info | null = null;
    try {
      storedInfo = obsPhoto?.cameraInfo
        ? JSON.parse( obsPhoto.cameraInfo )
        : null;
    } catch {
      storedInfo = null;
    }
    return {
      deviceUri: url
        ? obsPhoto?.originalDevicePhotoUri ?? null
        : null,
      stored: storedInfo,
    };
  }, [realm, uri, url] );
  const key = `${uri}|${deviceUri}`;
  // Saved before the full tag list was, so read the photo again where it can be.
  const complete = stored?.metadata
    ? stored
    : null;

  useEffect( ( ) => {
    if ( complete || ( !uri && !deviceUri ) ) return;
    ( async ( ) => {
      // The library original fills in what the local copy lost, like a Canon
      // focus distance when the photo was imported from the library.
      const local = uri
        ? await readCameraInfo( uri )
        : null;
      const original = deviceUri && ( !local || !local.focusDistance )
        ? await readCameraInfo( deviceUri )
        : null;
      setRead( {
        key,
        info: local || original
          ? {
            ...original,
            ...Object.fromEntries( Object.entries( local ?? {} ).filter( ( [, value] ) => value ) ),
          }
          : null,
      } );
    } )( );
  }, [complete, uri, deviceUri, key] );

  // Only the current photo's info, never the previous one's while it loads.
  const info = complete || ( read?.key === key && read.info ) || stored;
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
    ...( info.metadata ?? [] ),
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
        // Above the thumbnails, which render after this in MediaViewer
        <View className="absolute inset-0 z-10" pointerEvents="box-none">
          <BottomSheet
            headerText={t( "Camera-settings" )}
            onPressClose={( ) => setShowTable( false )}
            insideModal
            scrollEnabled
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
        </View>
      )}
    </>
  );
};

export default PhotoCameraInfo;
