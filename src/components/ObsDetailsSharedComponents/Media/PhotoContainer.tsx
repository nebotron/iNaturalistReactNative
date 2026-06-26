import {
  ActivityIndicator, Body2, Body4, INatIcon, OfflineNotice,
} from "components/SharedComponents";
import { Image, Pressable, View } from "components/styledComponents";
import React, { useEffect, useState } from "react";
import type { ImageStyle, StyleProp } from "react-native";
import Photo from "realmModels/Photo";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

interface Props {
  photo: {
    id: number;
    url: string;
    localFilePath: string;
    attribution: string;
    hidden: boolean;
  };
  onPress: () => void;
  style?: StyleProp<ImageStyle>;
}

const PhotoContainer = ( { photo, onPress, style }: Props ) => {
  const { t } = useTranslation( );
  const [localUri, setLocalUri] = useState<string | null>( null );
  const [loadError, setLoadError] = useState( false );

  const remoteUri = Photo.getLocalPhotoUri( photo.localFilePath )
    || Photo.displayLargePhoto( photo.url );

  useEffect( ( ) => {
    if ( !remoteUri ) return ( ) => {};
    let cancelled = false;
    setLocalUri( null );
    setLoadError( false );
    ensureLocalImageForCrop( remoteUri ).then( uri => {
      if ( !cancelled ) setLocalUri( uri );
    } ).catch( ( ) => {
      if ( !cancelled ) setLoadError( true );
    } );
    return ( ) => { cancelled = true; };
  }, [remoteUri] );

  if ( photo.hidden ) {
    return (
      <View className="p-4 justify-center items-center h-72 w-screen">
        <View className="flex-row justify-center mb-2 gap-x-2">
          <INatIcon name="private" size={18} color={colors.white} />
          <Body2 className="text-white">{t( "Content-Hidden" )}</Body2>
        </View>
        <Body4 className="text-white text-center italic">
          {t( "This-image-was-hidden-for-violating-community-guidelines-or-terms" )}
        </Body4>
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityHint={t( "View-photo" )}
      className="justify-center items-center"
      accessibilityLabel={photo.attribution}
    >
      { !localUri && !loadError && (
        <ActivityIndicator className="absolute" />
      ) }
      { localUri && (
        <Image
          testID="ObsMedia.photo"
          source={{ uri: localUri }}
          className="h-72 w-screen"
          style={style}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
        />
      ) }
      { loadError && (
        <View className="h-72 w-screen">
          <OfflineNotice
            onPress={( ) => {
              setLoadError( false );
              if ( remoteUri ) {
                ensureLocalImageForCrop( remoteUri )
                  .then( uri => setLocalUri( uri ) )
                  .catch( ( ) => setLoadError( true ) );
              }
            }}
            color="white"
          />
        </View>
      ) }
    </Pressable>
  );
};

export default PhotoContainer;
