import {
  Body3,
  Button,
  Heading4,
} from "components/SharedComponents";
import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import type { UsbFolderDiagnostics } from "sharedHelpers/usbStorage";
import {
  forgetUsbFolder,
  getUsbFolderDiagnostics,
  isCameraSubfolder,
  isUsbImportSupported,
  pickUsbFolder,
} from "sharedHelpers/usbStorage";
import { useTranslation } from "sharedHooks";

const UsbImportSetting = ( ) => {
  const { t } = useTranslation( );
  // Diagnostics rather than just the folder name: the name is null whenever the
  // drive isn't attached, which is most of the time, and a screen that says
  // "choose a folder" to someone who already chose one invites them to choose
  // another. bookmarkPresent says whether the feature is set up at all.
  const [folder, setFolder] = useState<UsbFolderDiagnostics | null>( null );

  const refresh = useCallback( async ( ) => {
    setFolder( await getUsbFolderDiagnostics( ) );
  }, [] );

  useEffect( ( ) => {
    getUsbFolderDiagnostics( ).then( setFolder );
  }, [] );

  const chooseFolder = useCallback( async ( ) => {
    await pickUsbFolder( );
    await refresh( );
  }, [refresh] );

  const forgetFolder = useCallback( async ( ) => {
    await forgetUsbFolder( );
    await refresh( );
  }, [refresh] );

  if ( !isUsbImportSupported( ) ) return null;

  const configured = !!folder?.bookmarkPresent;
  // The dead end this screen exists to prevent: a folder the camera fills once
  // and then abandons. Only visible while the drive is attached, since the
  // folder's parent can't be read otherwise — which is also the moment the
  // user is most likely here wondering why nothing imported.
  const cameraSubfolder = isCameraSubfolder( folder );

  const description = ( ) => {
    if ( !configured ) return t( "USB-import-description" );
    if ( folder?.name ) {
      return t( "USB-import-watching-folder", { folder: folder.name } );
    }
    return t( "USB-import-watching-folder-drive-not-connected" );
  };

  return (
    <View className="mt-[30px]">
      <Heading4 className="mb-[15px]">{t( "USB-PHOTO-IMPORT" )}</Heading4>
      <Body3 className="mb-[15px]">{description( )}</Body3>
      {cameraSubfolder && (
        <Body3 className="mb-[15px] color-warningRed">
          {t( "USB-import-folder-is-a-camera-subfolder", { folder: folder?.name } )}
        </Body3>
      )}
      {configured && cameraSubfolder && (
        <Button
          className="mb-[15px]"
          level="primary"
          text={t( "CHOOSE-USB-FOLDER" )}
          onPress={chooseFolder}
        />
      )}
      <Button
        level="neutral"
        text={configured
          ? t( "FORGET-USB-FOLDER" )
          : t( "CHOOSE-USB-FOLDER" )}
        onPress={configured
          ? forgetFolder
          : chooseFolder}
      />
    </View>
  );
};

export default UsbImportSetting;
