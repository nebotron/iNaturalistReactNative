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

  const [localImageUri, setLocalImageUri] = useState<string | null>( null );
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>( null );
  const [loading, setLoading] = useState( true );

  useEffect( ( ) => {
    let cancelled = false;
    setLoading( true );
    setLocalImageUri( null );
    setImageSize( null );

    ( async ( ) => {
      try {
        const resolvedUri = await ensureLocalImageForCrop( imageUri );
        if ( cancelled ) return;
        setLocalImageUri( resolvedUri );

        const size = await new Promise<{ w: number; h: number } | null>( resolve => {
          RNImage.getSize(
            resolvedUri,
            ( w, h ) => resolve( { w, h } ),
            ( ) => resolve( null ),
          );
        } );
        if ( !cancelled ) {
          setImageSize( size );
        }
      } catch {
        // leave localImageUri null so loading screen persists
      } finally {
        if ( !cancelled ) setLoading( false );
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
      : localImageUri;
    if ( uriToDelete ) {
      void ObservationPhoto.deletePhoto( uriToDelete, currentObservation );
      deletePhotoFromObservation( uriToDelete );
    }
    onCropSaved?.( );
    navigation.goBack( );
  }, [
    currentObservation,
    deletePhotoFromObservation,
    localImageUri,
    navigation,
    observationPhotoUuid,
    onCropSaved,
  ] );

  const handleConfirm = useCallback( ( crop: NormalizedCrop ) => {
    if ( !localImageUri || !imageSize || !observationPhotoUuid ) {
      return Promise.resolve( );
    }

    return ( async ( ) => {
      const croppedUri = await cropImageFile(
        localImageUri,
        crop,
        imageSize.w,
        imageSize.h,
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
    imageSize,
    localImageUri,
    navigation,
    observationPhotoUuid,
    onCropSaved,
    t,
    updateObservationKeys,
  ] );

  if ( loading || !localImageUri || !imageSize ) {
    return (
      <View className="flex-1 items-center justify-center bg-black">
        <ActivityIndicator color={colors.white} />
      </View>
    );
  }

  return (
    <ImageCropView
      sourceUri={localImageUri}
      imageWidth={imageSize.w}
      imageHeight={imageSize.h}
      framePadding={CROP_FRAME_PADDING}
      initialCrop={defaultSquareCrop( imageSize.w, imageSize.h )}
      labels={labels}
      onConfirm={handleConfirm}
      onDelete={handleDelete}
    />
  );
};

export default ImageCropEditor;
