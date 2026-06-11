import type { RouteProp } from "@react-navigation/native";
import { useNavigation, useRoute } from "@react-navigation/native";
import ImageCropView from "components/SharedComponents/ImageCrop/ImageCropView";
import { View } from "components/styledComponents";
import type { SharedStackParamList } from "navigation/types";
import React, {
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Image as RNImage,
} from "react-native";
import ObservationPhoto from "realmModels/ObservationPhoto";
import Photo from "realmModels/Photo";
import cropImageFile from "sharedHelpers/cropImageFile";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import type { NormalizedCrop } from "sharedHelpers/cropMath";
import { defaultSquareCrop } from "sharedHelpers/cropMath";
import useTranslation from "sharedHooks/useTranslation";
import useStore from "stores/useStore";
import colors from "styles/tailwindColors";

type Route = RouteProp<SharedStackParamList, "ImageCropEditor">;

const CROP_FRAME_PADDING = 0.045;

const ImageCropEditor = ( ) => {
  const navigation = useNavigation( );
  const { params } = useRoute<Route>( );
  const { t } = useTranslation( );
  const currentObservation = useStore( state => state.currentObservation );
  const updateObservationKeys = useStore( state => state.updateObservationKeys );
  const deletePhotoFromObservation = useStore( state => state.deletePhotoFromObservation );

  const { imageUri, observationPhotoUuid, onCropSaved } = params;

  const [imageInfo, setImageInfo] = useState<{
    uri: string;
    w: number;
    h: number;
  } | null>( null );

  useEffect( ( ) => {
    let cancelled = false;
    setImageInfo( null );

    ( async ( ) => {
      try {
        const uri = await ensureLocalImageForCrop( imageUri );
        if ( cancelled ) return;

        const size = await new Promise<{ w: number; h: number } | null>( resolve => {
          RNImage.getSize(
            uri,
            ( w, h ) => resolve( { w, h } ),
            ( ) => resolve( null ),
          );
        } );
        if ( !cancelled && size ) {
          setImageInfo( { uri, ...size } );
        }
      } catch {
        // leave imageInfo null so loading screen persists
      }
    } )( );

    return ( ) => { cancelled = true; };
  }, [imageUri] );

  const labels = {
    confirm: t( "SAVE-CROP" ),
    delete: t( "Delete-photo" ),
    instructions: t( "CROP-DRAG-HINT" ),
  };

  const handleDelete = useCallback( ( ) => {
    if ( !observationPhotoUuid || !currentObservation ) return;
    const obsPhoto = currentObservation.observationPhotos?.find(
      op => op.uuid === observationPhotoUuid,
    );
    const uriToDelete = obsPhoto?.photo
      ? Photo.displayCropSourcePhoto( obsPhoto.photo )
      : imageInfo?.uri;
    if ( uriToDelete ) {
      void ObservationPhoto.deletePhoto( uriToDelete, currentObservation );
      deletePhotoFromObservation( uriToDelete );
    }
    onCropSaved?.( );
    navigation.goBack( );
  }, [
    currentObservation,
    deletePhotoFromObservation,
    imageInfo?.uri,
    navigation,
    observationPhotoUuid,
    onCropSaved,
  ] );

  const handleConfirm = useCallback( ( crop: NormalizedCrop ) => {
    if ( !imageInfo || !observationPhotoUuid ) {
      return Promise.resolve( );
    }

    return ( async ( ) => {
      const croppedUri = await cropImageFile(
        imageInfo.uri,
        crop,
        imageInfo.w,
        imageInfo.h,
      );
      const resizedPath = await Photo.resizeImageForUpload( croppedUri );

      const photos = currentObservation?.observationPhotos ?? [];
      const idx = photos.findIndex( op => op.uuid === observationPhotoUuid );
      if ( idx >= 0 ) {
        const updated = [...photos];
        updated[idx] = {
          ...updated[idx],
          _updated_at: new Date( ),
          photo: {
            ...updated[idx].photo,
            localFilePath: resizedPath,
            _updated_at: new Date( ),
          },
        };
        updateObservationKeys( { observationPhotos: updated } );
      }

      onCropSaved?.( );
      navigation.goBack( );
    } )( ).catch( ( ) => {
      Alert.alert( t( "Something-went-wrong" ) );
    } );
  }, [
    currentObservation,
    imageInfo,
    navigation,
    observationPhotoUuid,
    onCropSaved,
    t,
    updateObservationKeys,
  ] );

  if ( !imageInfo ) {
    return (
      <View className="flex-1 items-center justify-center bg-black">
        <ActivityIndicator color={colors.white} />
      </View>
    );
  }

  return (
    <ImageCropView
      sourceUri={imageInfo.uri}
      imageWidth={imageInfo.w}
      imageHeight={imageInfo.h}
      framePadding={CROP_FRAME_PADDING}
      initialCrop={defaultSquareCrop( imageInfo.w, imageInfo.h )}
      labels={labels}
      onConfirm={handleConfirm}
      onDelete={handleDelete}
    />
  );
};

export default ImageCropEditor;
