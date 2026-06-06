import type { RouteProp } from "@react-navigation/native";
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  Button,
  ViewWrapper,
} from "components/SharedComponents";
import findGroupedPhotoByDisplayUri
  from "components/SharedComponents/ImageCrop/findGroupedPhotoByDisplayUri";
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
import { saveAnimalCrop } from "sharedHelpers/animalCropLog";
import { recordCropFeedback } from "sharedHelpers/cropFeedbackLog";
import cropImageFile from "sharedHelpers/cropImageFile";
import { cropOriginalUriFromPath, preserveCropOriginalPath } from "sharedHelpers/cropPhotoMetadata";
import {
  resolveDevicePhotoUriFromGroupedPhoto,
} from "sharedHelpers/deleteDevicePhotosDuringObservationPrep";
import detectSubjectInImage from "sharedHelpers/detectSubjectInImage";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import useCurrentUser from "sharedHooks/useCurrentUser";
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
  const currentUser = useCurrentUser( );
  const currentObservation = useStore( state => state.currentObservation );
  const updateObservationKeys = useStore( state => state.updateObservationKeys );
  const deletePhotoFromObservation = useStore( state => state.deletePhotoFromObservation );
  const groupedPhotos = useStore( state => state.groupedPhotos );
  const setGroupedPhotos = useStore( state => state.setGroupedPhotos );
  const addPendingGroupPhotoDeletionUri = useStore(
    state => state.addPendingGroupPhotoDeletionUri,
  );

  const imageUri = params?.imageUri;
  const context = params?.context;
  const observationPhotoUuid = params?.observationPhotoUuid;
  const onCropSaved = params?.onCropSaved;
  const pendingImageUris = params?.pendingImageUris;

  const [localImageUri, setLocalImageUri] = useState<string | null>( null );
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>( null );
  const [detectedCrop, setDetectedCrop] = useState<NormalizedCrop | null>( null );
  const [savedInitialCrop, setSavedInitialCrop] = useState<NormalizedCrop | null>( null );
  const [loadingSource, setLoadingSource] = useState( true );

  const getCropFeedbackSourceKey = useCallback( ( ) => {
    if ( context === "groupPhotos" && imageUri ) {
      const groupedPhoto = findGroupedPhotoByDisplayUri( groupedPhotos, imageUri );
      return groupedPhoto?.image.cropOriginalUri || localImageUri || imageUri;
    }

    if ( context === "observationEdit" && observationPhotoUuid && currentObservation ) {
      const obsPhoto = currentObservation.observationPhotos?.find(
        op => op.uuid === observationPhotoUuid,
      );
      return cropOriginalUriFromPath( obsPhoto?.photo?.cropOriginalLocalFilePath )
        || localImageUri
        || imageUri
        || null;
    }

    return localImageUri || imageUri || null;
  }, [
    context,
    currentObservation,
    groupedPhotos,
    imageUri,
    localImageUri,
    observationPhotoUuid,
  ] );

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
    setDetectedCrop( null );
    setSavedInitialCrop( null );

    ( async ( ) => {
      try {
        let cropSourceUri = imageUri;
        let existingSavedCrop: NormalizedCrop | null = null;

        if ( context === "observationEdit" && observationPhotoUuid && currentObservation ) {
          const obsPhoto = currentObservation.observationPhotos?.find(
            op => op.uuid === observationPhotoUuid,
          );
          const photo = obsPhoto?.photo;
          if ( photo ) {
            cropSourceUri = Photo.displayCropEditorSourcePhoto( photo ) || imageUri;
            existingSavedCrop = Photo.savedNormalizedCrop( photo );
          }
        } else if ( context === "groupPhotos" ) {
          const groupedPhoto = findGroupedPhotoByDisplayUri( groupedPhotos, imageUri );
          if ( groupedPhoto ) {
            cropSourceUri = groupedPhoto.image.cropOriginalUri || imageUri;
            existingSavedCrop = groupedPhoto.image.crop ?? null;
          }
        }

        const resolvedUri = await ensureLocalImageForCrop( cropSourceUri );
        if ( cancelled ) {
          return;
        }
        setLocalImageUri( resolvedUri );
        const size = await new Promise<{ w: number; h: number } | null>( resolve => {
          RNImage.getSize(
            resolvedUri,
            ( w, h ) => resolve( { w, h } ),
            ( ) => resolve( null ),
          );
        } );
        if ( cancelled ) {
          return;
        }
        if ( !size ) {
          setImageSize( null );
          return;
        }
        setImageSize( size );
        if ( existingSavedCrop ) {
          setSavedInitialCrop( existingSavedCrop );
        }
        const initialCrop = existingSavedCrop
          || await detectSubjectInImage( resolvedUri, size.w, size.h );
        if ( !cancelled ) {
          setDetectedCrop( initialCrop );
        }
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
  }, [
    context,
    currentObservation,
    groupedPhotos,
    imageUri,
    observationPhotoUuid,
  ] );

  const labels = useMemo( ( ) => ( {
    confirm: t( "SAVE-CROP" ),
    delete: t( "Delete-photo" ),
    instructions: t( "CROP-DRAG-HINT" ),
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
    const sourceKey = getCropFeedbackSourceKey( );
    if ( sourceKey ) {
      recordCropFeedback( sourceKey, { crop: null, kept: false } );
    }

    if ( context === "groupPhotos" && imageUri ) {
      const groupedPhoto = findGroupedPhotoByDisplayUri( groupedPhotos, imageUri );
      if ( groupedPhoto ) {
        const deviceUri = resolveDevicePhotoUriFromGroupedPhoto( groupedPhoto );
        if ( deviceUri ) {
          addPendingGroupPhotoDeletionUri( deviceUri );
        }
      }
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
    addPendingGroupPhotoDeletionUri,
    context,
    currentObservation,
    deletePhotoFromObservation,
    finishOrAdvance,
    getCropFeedbackSourceKey,
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

      let feedbackSourceKey = getCropFeedbackSourceKey( );

      if ( context === "groupPhotos" ) {
        const groupedPhoto = findGroupedPhotoByDisplayUri( groupedPhotos, imageUri );
        const cropOriginalPath = await preserveCropOriginalPath(
          localImageUri,
          groupedPhoto?.image.cropOriginalUri,
        );
        const cropOriginalUri = cropOriginalUriFromPath( cropOriginalPath ) || localImageUri;
        feedbackSourceKey = cropOriginalUri;
        setGroupedPhotos(
          groupedPhotos.map( group => {
            const photos = group.photos?.map( photo => (
              photo.image.uri === imageUri
                ? {
                  ...photo,
                  image: {
                    ...photo.image,
                    uri: croppedUri,
                    cropOriginalUri,
                    crop,
                  },
                }
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
          const existingPhoto = obs.observationPhotos[idx].photo;
          const cropOriginalLocalFilePath = await Photo.preserveCropOriginal(
            localImageUri,
            existingPhoto,
          );
          feedbackSourceKey = cropOriginalUriFromPath( cropOriginalLocalFilePath )
            || feedbackSourceKey;
          const resizedPath = await Photo.resizeImageForUpload( croppedUri );
          obs.observationPhotos = [...obs.observationPhotos];
          obs.observationPhotos[idx] = {
            ...obs.observationPhotos[idx],
            _updated_at: new Date( ),
            photo: {
              ...existingPhoto,
              localFilePath: resizedPath,
              cropOriginalLocalFilePath,
              ...Photo.cropMetadataFromNormalizedCrop( crop ),
              _updated_at: new Date( ),
            },
          };
          updateObservationKeys( { observationPhotos: obs.observationPhotos } );

          const obsUserId = currentObservation?.user?.id;
          const remotePhotoUrl = Photo.displayOriginalPhoto( existingPhoto?.url );
          if (
            remotePhotoUrl
            && obsUserId
            && currentUser?.id
            && obsUserId !== currentUser.id
          ) {
            saveAnimalCrop( remotePhotoUrl, crop );
          }
        }
      }

      if ( feedbackSourceKey ) {
        recordCropFeedback( feedbackSourceKey, { crop, kept: true } );
      }

      finishOrAdvance( );
    } )( ).catch( ( ) => {
      Alert.alert( t( "Something-went-wrong" ) );
    } );
  }, [
    context,
    currentObservation,
    currentUser,
    finishOrAdvance,
    getCropFeedbackSourceKey,
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

  const activeInitialCrop = savedInitialCrop ?? detectedCrop;

  if ( loadingSource || !localImageUri || !imageSize || !activeInitialCrop ) {
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
      initialCrop={activeInitialCrop}
      labels={labels}
      onConfirm={handleConfirm}
      onDelete={handleDelete}
    />
  );
};

export default ImageCropEditor;
