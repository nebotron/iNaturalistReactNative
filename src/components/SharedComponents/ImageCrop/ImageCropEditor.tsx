import type { RouteProp } from "@react-navigation/native";
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  Button,
  ViewWrapper,
} from "components/SharedComponents";
import ImageCropView from "components/SharedComponents/ImageCrop/ImageCropView";
import { View } from "components/styledComponents";
import cloneDeep from "lodash/cloneDeep";
import type { SharedStackParamList } from "navigation/types";
import React, {
  useCallback,
  useEffect,
  useMemo,
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
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import useTranslation from "sharedHooks/useTranslation";
import useStore from "stores/useStore";
import colors from "styles/tailwindColors";

type Route = RouteProp<SharedStackParamList, "ImageCropEditor">;

// Default squareShape uses framePadding 0.15 (70% of max). 0.045 → ~91% (~30% larger).
const CROP_FRAME_PADDING = 0.045;

const ImageCropEditor = ( ) => {
  const navigation = useNavigation( );
  const { params } = useRoute<Route>( );
  const { t } = useTranslation( );
  const currentObservation = useStore( state => state.currentObservation );
  const updateObservationKeys = useStore( state => state.updateObservationKeys );
  const deletePhotoFromObservation = useStore( state => state.deletePhotoFromObservation );
  const groupedPhotos = useStore( state => state.groupedPhotos );
  const setGroupedPhotos = useStore( state => state.setGroupedPhotos );

  const imageUri = params?.imageUri;
  const context = params?.context;
  const observationPhotoUuid = params?.observationPhotoUuid;
  const onCropSaved = params?.onCropSaved;
  const pendingImageUris = params?.pendingImageUris;

  const [localImageUri, setLocalImageUri] = useState<string | null>( null );
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>( null );
  const [loadingSource, setLoadingSource] = useState( true );

  useEffect( ( ) => {
    navigation.setOptions( { headerShown: false } );
  }, [navigation] );

  useEffect( ( ) => {
    if ( !imageUri ) {
      return ( ) => {};
    }

    let cancelled = false;
    setLoadingSource( true );
    setLocalImageUri( null );
    setImageSize( null );

    ( async ( ) => {
      try {
        const resolvedUri = await ensureLocalImageForCrop( imageUri );
        if ( cancelled ) {
          return;
        }
        setLocalImageUri( resolvedUri );
        RNImage.getSize(
          resolvedUri,
          ( w, h ) => {
            if ( !cancelled ) {
              setImageSize( { w, h } );
            }
          },
          ( ) => {
            if ( !cancelled ) {
              setImageSize( null );
            }
          },
        );
      } catch {
        if ( !cancelled ) {
          setLocalImageUri( null );
        }
      } finally {
        if ( !cancelled ) {
          setLoadingSource( false );
        }
      }
    } )( );

    return ( ) => {
      cancelled = true;
    };
  }, [imageUri] );

  const labels = useMemo( ( ) => ( {
    confirm: t( "SAVE-CROP" ),
    delete: t( "Delete-photo" ),
    instructions: t( "CROP-DRAG-HINT" ),
    errorMessage: t( "Something-went-wrong" ),
  } ), [t] );

  const finishOrAdvance = useCallback( ( ) => {
    if ( pendingImageUris?.length ) {
      navigation.replace( "ImageCropEditor", {
        imageUri: pendingImageUris[0],
        pendingImageUris: pendingImageUris.slice( 1 ),
        context,
        observationPhotoUuid,
        onCropSaved,
      } );
      return;
    }
    onCropSaved?.( );
    navigation.goBack( );
  }, [
    context,
    navigation,
    observationPhotoUuid,
    onCropSaved,
    pendingImageUris,
  ] );

  const handleDelete = useCallback( ( ) => {
    if ( context === "groupPhotos" && imageUri ) {
      setGroupedPhotos(
        groupedPhotos
          .map( group => {
            const photos = group.photos?.filter(
              photo => photo.image.uri !== imageUri,
            );
            if ( !photos?.length && !group.videos?.length ) {
              return null;
            }
            return photos
              ? { ...group, photos }
              : group;
          } )
          .filter( Boolean ) as typeof groupedPhotos,
      );
      finishOrAdvance( );
      return;
    }

    if ( context === "observationEdit" && observationPhotoUuid && currentObservation ) {
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
    }
  }, [
    context,
    currentObservation,
    deletePhotoFromObservation,
    finishOrAdvance,
    groupedPhotos,
    imageUri,
    localImageUri,
    navigation,
    observationPhotoUuid,
    onCropSaved,
    setGroupedPhotos,
  ] );

  const handleConfirm = useCallback( ( crop: NormalizedCrop ) => {
    if ( !localImageUri || !imageUri || !imageSize ) {
      return Promise.resolve( );
    }

    return ( async ( ) => {
      const croppedUri = await cropImageFile(
        localImageUri,
        crop,
        imageSize.w,
        imageSize.h,
      );

      if ( context === "groupPhotos" ) {
        setGroupedPhotos(
          groupedPhotos.map( group => {
            const photos = group.photos?.map( photo => (
              photo.image.uri === imageUri
                ? { image: { uri: croppedUri } }
                : photo
            ) );
            return photos
              ? { ...group, photos }
              : group;
          } ),
        );
      } else if ( context === "observationEdit" && observationPhotoUuid ) {
        const obs = cloneDeep( currentObservation );
        const idx = obs?.observationPhotos?.findIndex(
          op => op.uuid === observationPhotoUuid,
        ) ?? -1;
        if ( idx >= 0 && obs?.observationPhotos ) {
          const resizedPath = await Photo.resizeImageForUpload( croppedUri );
          obs.observationPhotos = [...obs.observationPhotos];
          obs.observationPhotos[idx] = {
            ...obs.observationPhotos[idx],
            _updated_at: new Date( ),
            photo: {
              ...obs.observationPhotos[idx].photo,
              localFilePath: resizedPath,
              _updated_at: new Date( ),
            },
          };
          updateObservationKeys( { observationPhotos: obs.observationPhotos } );
        }
      }

      finishOrAdvance( );
    } )( ).catch( ( ) => {
      Alert.alert( t( "Something-went-wrong" ) );
    } );
  }, [
    context,
    currentObservation,
    finishOrAdvance,
    groupedPhotos,
    imageSize,
    imageUri,
    localImageUri,
    observationPhotoUuid,
    setGroupedPhotos,
    t,
    updateObservationKeys,
  ] );

  if ( !imageUri ) {
    return (
      <ViewWrapper>
        <View className="p-4">
          <Button
            level="focus"
            onPress={( ) => navigation.goBack( )}
            text={t( "Go-back" )}
          />
        </View>
      </ViewWrapper>
    );
  }

  if ( loadingSource || !localImageUri || !imageSize ) {
    return (
      <View className="flex-1 items-center justify-center bg-black">
        <ActivityIndicator color={colors.white} />
      </View>
    );
  }

  return (
    <ImageCropView
      key={localImageUri}
      sourceUri={localImageUri}
      imageWidth={imageSize.w}
      imageHeight={imageSize.h}
      framePadding={CROP_FRAME_PADDING}
      labels={labels}
      onConfirm={handleConfirm}
      onDelete={handleDelete}
    />
  );
};

export default ImageCropEditor;
