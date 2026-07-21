import {
  Body3,
  Button,
  Heading4,
} from "components/SharedComponents";
import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import {
  forgetUsbFolder,
  getUsbFolderName,
  isUsbImportSupported,
  pickUsbFolder,
} from "sharedHelpers/usbStorage";
import { useTranslation } from "sharedHooks";

const UsbImportSetting = ( ) => {
  const { t } = useTranslation( );
  const [folderName, setFolderName] = useState<string | null>( null );

  useEffect( ( ) => {
    getUsbFolderName( ).then( setFolderName );
  }, [] );

  const chooseFolder = useCallback( async ( ) => {
    const name = await pickUsbFolder( );
    if ( name ) setFolderName( name );
  }, [] );

  const forgetFolder = useCallback( async ( ) => {
    await forgetUsbFolder( );
    setFolderName( null );
  }, [] );

  if ( !isUsbImportSupported( ) ) return null;

  return (
    <View className="mt-[30px]">
      <Heading4 className="mb-[15px]">{t( "USB-PHOTO-IMPORT" )}</Heading4>
      <Body3 className="mb-[15px]">
        {folderName
          ? t( "USB-import-watching-folder", { folder: folderName } )
          : t( "USB-import-description" )}
      </Body3>
      <Button
        level="neutral"
        text={folderName
          ? t( "FORGET-USB-FOLDER" )
          : t( "CHOOSE-USB-FOLDER" )}
        onPress={folderName
          ? forgetFolder
          : chooseFolder}
      />
    </View>
  );
};

export default UsbImportSetting;
