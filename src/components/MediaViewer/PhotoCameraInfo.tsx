import GearNicknameSheet from "components/GearNicknames/GearNicknameSheet";
import {
  Body3, Body4, BottomSheet,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useEffect, useMemo, useState } from "react";
import { useWindowDimensions } from "react-native";
import type { RealmObservation } from "realmModels/types";
import type { GearKind } from "sharedHelpers/gearNicknames";
import {
  libraryOriginalQuery, readLibraryCameraInfo,
} from "sharedHelpers/findLibraryOriginal";
import type { PhotoCameraInfo as Info } from "sharedHelpers/photoCameraInfo";
import { readCameraInfo } from "sharedHelpers/photoCameraInfo";
import { useGearNicknames, useTranslation } from "sharedHooks";

const { useRealm } = RealmContext;

interface Props {
  uri?: string | null;
  url?: string | null;
}

// Camera, lens, exposure and focus distance saved when the photo was added, else
// read from the EXIF of the local copy, filled in from the original in the
// photo library for uploaded photos (iNaturalist strips EXIF from the copies it
// hosts) and anything the local copy lost. Tapping the summary shows every
// value in a table.
const PhotoCameraInfo = ( { uri, url }: Props ) => {
  const { t } = useTranslation( );
  const { height: windowHeight } = useWindowDimensions( );
  const realm = useRealm( );
  const [read, setRead] = useState<{ key: string; info: Info | null } | null>( null );
  const [showTable, setShowTable] = useState( false );
  const { nameGear } = useGearNicknames( );
  // Camera or lens being renamed from the table
  const [renaming, setRenaming] = useState<{ kind: GearKind; name: string } | null>( null );

  const { library, stored } = useMemo( ( ) => {
    const query = url
      ? ["ANY observationPhotos.photo.url == $0", url]
      : uri && ["ANY observationPhotos.photo.localFilePath ENDSWITH $0", uri.split( "/" ).pop( )];
    if ( !query ) return { library: null, stored: null };
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
      library: obsPhoto
        ? libraryOriginalQuery( obsPhoto, observation )
        : null,
      stored: storedInfo,
    };
  }, [realm, uri, url] );
  const key = `${uri}|${library?.uuid}`;
  // Saved before the full tag list was, or without a focus distance the
  // library original may still have, so read the photos again where they can be.
  const complete = stored?.metadata && stored.focusDistance
    ? stored
    : null;

  useEffect( ( ) => {
    if ( complete || ( !uri && !library ) ) return;
    ( async ( ) => {
      // The library original fills in what the local copy lost, like a Canon
      // focus distance when the photo was imported from the library.
      const local = uri
        ? await readCameraInfo( uri )
        : null;
      const original = library && !local?.focusDistance
        ? await readLibraryCameraInfo( library )
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
  }, [complete, uri, library, key] );

  // Only the current photo's info, never the previous one's while it loads.
  const info = complete || ( read?.key === key && read.info ) || stored;
  // Always two single-line rows, so the sliders above don't move whether or
  // not this photo has camera info.
  if ( !info ) {
    return (
      <View className="px-4 py-1" accessibilityElementsHidden>
        <Body4 numberOfLines={1}>{" "}</Body4>
        <Body4 numberOfLines={1}>{" "}</Body4>
      </View>
    );
  }
  const camera = nameGear( "camera", info.camera );
  const lens = nameGear( "lens", info.lens );
  const lines = [
    [camera, lens].filter( Boolean ).join( " · " ),
    [
      info.focalLength,
      info.aperture,
      info.shutterSpeed,
      info.iso && t( "ISO-value", { iso: info.iso } ),
      info.focusDistance,
    ].filter( Boolean ).join( " · " ),
  ];
  // Camera and lens rows show the nickname and can be tapped to rename
  const gearRows: Record<string, { kind: GearKind; name: string }> = {};
  if ( info.camera ) gearRows[t( "Camera" )] = { kind: "camera", name: info.camera };
  if ( info.lens ) gearRows[t( "Lens" )] = { kind: "lens", name: info.lens };
  const rows = [
    [t( "Camera" ), camera],
    [t( "Lens" ), lens],
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
        {lines.map( ( line, index ) => (
          // eslint-disable-next-line react/no-array-index-key
          <Body4 key={index} numberOfLines={1} className="text-white text-center">
            {line || " "}
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
            maxHeight={windowHeight * 0.6}
          >
            <View className="p-5">
              {rows.map( ( [label, value] ) => {
                const gear = gearRows[label];
                if ( gear ) {
                  return (
                    <Pressable
                      key={label}
                      accessibilityRole="button"
                      accessibilityHint={t( "Renames-this-camera-or-lens" )}
                      className="flex-row justify-between py-2 border-b border-lightGray"
                      onPress={( ) => {
                        setShowTable( false );
                        setRenaming( gear );
                      }}
                    >
                      <Body3 className="font-bold mr-4">{label}</Body3>
                      <View className="flex-1">
                        <Body3 className="text-right underline">{value}</Body3>
                        {value !== gear.name && (
                          <Body4 className="text-right text-darkGrayDisabled">
                            {gear.name}
                          </Body4>
                        )}
                      </View>
                    </Pressable>
                  );
                }
                return (
                  <View
                    key={label}
                    className="flex-row justify-between py-2 border-b border-lightGray"
                  >
                    <Body3 className="font-bold mr-4">{label}</Body3>
                    <Body3 className="flex-1 text-right" selectable>{value}</Body3>
                  </View>
                );
              } )}
            </View>
          </BottomSheet>
        </View>
      )}
      {renaming && (
        <View className="absolute inset-0 z-10" pointerEvents="box-none">
          <GearNicknameSheet
            kind={renaming.kind}
            name={renaming.name}
            insideModal
            onPressClose={( ) => {
              setRenaming( null );
              setShowTable( true );
            }}
          />
        </View>
      )}
    </>
  );
};

export default PhotoCameraInfo;
