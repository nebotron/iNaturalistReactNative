import type { RouteProp } from "@react-navigation/native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { applyGroupPhotosCrop } from "components/PhotoImporter/helpers/groupPhotoCrops";
import {
  BackButton,
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
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  InteractionManager,
} from "react-native";
import ObservationPhoto from "realmModels/ObservationPhoto";
import Photo from "realmModels/Photo";
import { saveAnimalCrop } from "sharedHelpers/animalCropLog";
import { recordCropFeedback } from "sharedHelpers/cropFeedbackLog";
import cropImageFile from "sharedHelpers/cropImageFile";
import { cropOriginalUriFromPath } from "sharedHelpers/cropPhotoMetadata";
import {
  resolveDevicePhotoUriFromGroupedPhoto,
} from "sharedHelpers/deleteDevicePhotosDuringObservationPrep";
import type { PreloadResult } from "sharedHelpers/imageCropPreload";
import {
  enqueuePreload,
  preloadCache,
  preloadImage,
} from "sharedHelpers/imageCropPreload";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { trackGroupPhotoCrop } from "sharedHelpers/pendingGroupPhotoCrops";
import { addRemovedGroupPhotoUris } from "sharedHelpers/removedGroupPhotoUris";
import useTranslation from "sharedHooks/useTranslation";
import useStore from "stores/useStore";
import colors from "styles/tailwindColors";

type Route = RouteProp<SharedStackParamList, "ImageCropEditor">;

const logger = log.extend( "ImageCropEditor" );

// How many upcoming photos in a bulk crop to preload ahead of the one
// currently shown.
const PRELOAD_LOOKAHEAD = 3;

const ImageCropEditor = ( ) => {
  const navigation = useNavigation( );
  const { params } = useRoute<Route>( );
  const { t } = useTranslation( );
  const currentObservation = useStore( state => state.currentObservation );
  const updateObservationKeys = useStore( state => state.updateObservationKeys );
  const deletePhotoFromObservation = useStore( state => state.deletePhotoFromObservation );
  const groupedPhotos = useStore( state => state.groupedPhotos );
  const setGroupedPhotos = useStore( state => state.setGroupedPhotos );
  const addPendingGroupPhotoDeletionUri = useStore(
    state => state.addPendingGroupPhotoDeletionUri,
  );

  const context = params?.context;
  const observationPhotoUuid = params?.observationPhotoUuid;
  const onCropSaved = params?.onCropSaved;

  // The photo currently being cropped and the rest of the bulk crop queue.
  // Held in state rather than read from route params on every render because a
  // bulk crop advances by swapping these in place (see finishOrAdvance).
  const [imageUri, setImageUri] = useState( params?.imageUri );
  const [pendingImageUris, setPendingImageUris] = useState<string[]>(
    params?.pendingImageUris ?? [],
  );

  // Resolve the crop source URI and any previously-saved crop for the current
  // image. Pure read of props/store, shared by the synchronous cache seed and
  // the async load effect below.
  const resolveCropContext = useCallback( ( ): {
    cropSourceUri: string;
    existingSavedCrop: NormalizedCrop | null;
  } => {
    if ( !imageUri ) {
      return { cropSourceUri: "", existingSavedCrop: null };
    }
    if ( context === "observationEdit" && observationPhotoUuid && currentObservation ) {
      const obsPhoto = currentObservation.observationPhotos?.find(
        op => op.uuid === observationPhotoUuid,
      );
      const photo = obsPhoto?.photo;
      if ( photo ) {
        return {
          cropSourceUri: Photo.displayCropEditorSourcePhoto( photo ) || imageUri,
          existingSavedCrop: Photo.savedNormalizedCrop( photo ),
        };
      }
    } else if ( context === "groupPhotos" ) {
      const groupedPhoto = findGroupedPhotoByDisplayUri( groupedPhotos, imageUri );
      if ( groupedPhoto ) {
        return {
          cropSourceUri: groupedPhoto.image.cropOriginalUri || imageUri,
          existingSavedCrop: groupedPhoto.image.crop ?? null,
        };
      }
    }
    return { cropSourceUri: imageUri, existingSavedCrop: null };
  }, [context, currentObservation, groupedPhotos, imageUri, observationPhotoUuid] );

  const [localImageUri, setLocalImageUri] = useState<string | null>( null );
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>( null );
  const [detectedCrop, setDetectedCrop] = useState<NormalizedCrop | null>( null );
  const [savedInitialCrop, setSavedInitialCrop] = useState<NormalizedCrop | null>( null );
  const [loadingSource, setLoadingSource] = useState( true );
  const [seededUri, setSeededUri] = useState<string | null>( null );

  // Seed state from the preload cache during render, before the first paint of
  // each image, so mounting the editor (and advancing to the next photo in a
  // bulk crop) shows an already-preloaded image immediately instead of painting
  // a spinner, or the previous photo, while the async effect below re-reads the
  // same cached data.
  if ( imageUri && seededUri !== imageUri ) {
    setSeededUri( imageUri );
    const cached = preloadCache.get( imageUri );
    const { existingSavedCrop } = resolveCropContext( );
    setLocalImageUri( cached?.localUri ?? null );
    setImageSize( cached?.size ?? null );
    setSavedInitialCrop( cached
      ? existingSavedCrop
      : null );
    setDetectedCrop( cached
      ? existingSavedCrop ?? cached.crop
      : null );
    setLoadingSource( !cached );
  }

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

  // Track which imageUri's preload we've already kicked off to avoid re-triggering
  const preloadedUrisRef = useRef( new Set<string>( ) );

  const applyPreloadResult = useCallback( (
    result: PreloadResult,
    existingSavedCrop: NormalizedCrop | null,
  ) => {
    setLocalImageUri( result.localUri );
    setImageSize( result.size );
    if ( existingSavedCrop ) {
      setSavedInitialCrop( existingSavedCrop );
    }
    setDetectedCrop( existingSavedCrop ?? result.crop );
    setLoadingSource( false );
  }, [] );

  useEffect( ( ) => {
    if ( !imageUri ) {
      return ( ) => {};
    }

    const { cropSourceUri, existingSavedCrop } = resolveCropContext( );

    // Always go through preloadImage, even for a URI the cache already holds
    // (it resolves from the cache without reloading anything). Bailing out on
    // a cache hit assumed the render-time seed had applied it, but this effect
    // re-runs on any store write — resolveCropContext reads the store — and a
    // re-run cancels the load in flight. When that cancelled load is what
    // filled the cache, there was nothing left to apply it or to clear
    // loadingSource, so the screen sat on its spinner forever.
    let cancelled = false;

    ( async ( ) => {
      try {
        // Reuse an in-flight preload for this URI (kicked off before navigation)
        // instead of starting a second, contending load of the same image.
        const result = await preloadImage( imageUri, cropSourceUri, existingSavedCrop );
        if ( cancelled ) {
          return;
        }
        if ( !result ) {
          // The screen can only show its spinner without an image to crop, so
          // a load that fails silently is indistinguishable from one still
          // running. Say which photo it was.
          logger.error( `Could not load an image to crop (source ${cropSourceUri})` );
          setImageSize( null );
          return;
        }
        applyPreloadResult( result, existingSavedCrop );
      } catch ( error ) {
        if ( !cancelled ) {
          logger.error( "Failed to load an image to crop", error );
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
  }, [applyPreloadResult, imageUri, resolveCropContext] );

  // Preload only the next couple of pending images (local file export +
  // subject detection, via enqueuePreload/preloadImage) as soon as this
  // screen mounts, rather than the whole remaining batch — a bulk crop can
  // span dozens of photos, and preloading them all wastes work on photos the
  // user may delete or never reach. Advancing drops one uri from the queue and
  // re-runs this, so the lookahead slides forward as the user advances.
  // The immediately-next photo is started right away, because how long the
  // spinner sits between photos is exactly how much of its load is still
  // outstanding when the user taps the checkmark. The rest of the lookahead is
  // deferred past interactions so the burst doesn't contend with painting the
  // current image.
  useEffect( ( ) => {
    if ( !pendingImageUris.length || context !== "groupPhotos" ) {
      return ( ) => {};
    }
    const preload = ( uri: string ) => {
      if ( preloadedUrisRef.current.has( uri ) ) {
        return;
      }
      preloadedUrisRef.current.add( uri );
      const groupedPhoto = findGroupedPhotoByDisplayUri( groupedPhotos, uri );
      const cropSourceUri = groupedPhoto?.image.cropOriginalUri || uri;
      const existingSavedCrop = groupedPhoto?.image.crop ?? null;
      enqueuePreload( uri, cropSourceUri, existingSavedCrop );
    };
    preload( pendingImageUris[0] );
    const handle = InteractionManager.runAfterInteractions( ( ) => {
      pendingImageUris.slice( 1, PRELOAD_LOOKAHEAD ).forEach( preload );
    } );
    return ( ) => handle.cancel( );
  }, [context, groupedPhotos, pendingImageUris] );

  const labels = useMemo( ( ) => ( {
    confirm: t( "SAVE-CROP" ),
    delete: t( "Delete-photo" ),
    instructions: t( "CROP-DRAG-HINT" ),
  } ), [t] );

  // Advance to the next photo in place instead of navigation.replace: a stack
  // replace tears the editor down and rebuilds it, and plays both the screen
  // transition and the fade in/out, which is most of the delay between photos
  // in a bulk crop. Swapping the uri keeps the mounted cropper (ImageCropView
  // resets itself when sourceUri changes), so a preloaded next image appears on
  // the next frame.
  const finishOrAdvance = useCallback( ( ) => {
    if ( pendingImageUris.length ) {
      setImageUri( pendingImageUris[0] );
      setPendingImageUris( uris => uris.slice( 1 ) );
      return;
    }
    onCropSaved?.( );
    navigation.goBack( );
  }, [
    navigation,
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
          // Same as removing from the Group Photos grid: record it regardless
          // of whether the device deletion later succeeds, so the photo stays
          // hidden from the photo picker (see removedGroupPhotoUris.ts).
          addRemovedGroupPhotoUris( [deviceUri] );
        }
      }
      setGroupedPhotos(
        groupedPhotos
          .map( group => {
            const photos = group.photos?.filter(
              photo => photo.image.uri !== imageUri,
            );
            if ( !photos?.length ) {
              // If the group had a sound, keep it as a sound-only item
              return group.soundUri
                ? { soundUri: group.soundUri, timestamp: group.timestamp }
                : null;
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

    // Cropping the file and copying the original take long enough to feel like
    // a stall after every checkmark tap in a bulk crop, and nothing on screen
    // needs the result, so advance right away and let the writes finish in the
    // background (deferred past pending interactions so they don't contend with
    // painting the next image). GroupPhotosContainer waits on the tracked jobs
    // before importing.
    if ( context === "groupPhotos" ) {
      const displayUri = imageUri;
      const sourceUri = localImageUri;
      const size = imageSize;
      trackGroupPhotoCrop( ( async ( ) => {
        await new Promise<void>( resolve => {
          InteractionManager.runAfterInteractions( ( ) => resolve( ) );
        } );
        await applyGroupPhotosCrop( crop, displayUri, sourceUri, size );
      } )( ).catch( ( ) => {
        Alert.alert( t( "Something-went-wrong" ) );
      } ) );
      finishOrAdvance( );
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

      if ( context === "observationEdit" && observationPhotoUuid ) {
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

          const photoUrl = Photo.displayLocalOrRemoteLargePhoto( existingPhoto );
          if ( photoUrl ) {
            saveAnimalCrop( photoUrl, crop );
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
    finishOrAdvance,
    getCropFeedbackSourceKey,
    imageSize,
    imageUri,
    localImageUri,
    observationPhotoUuid,
    t,
    updateObservationKeys,
  ] );

  // Key the exposure slider's brightness label to the same identifier the
  // animal-crop log uses for this photo, so the two logs correlate.
  const brightnessLogKey = useMemo( ( ) => {
    if ( context === "observationEdit" && observationPhotoUuid && currentObservation ) {
      const obsPhoto = currentObservation.observationPhotos?.find(
        op => op.uuid === observationPhotoUuid,
      );
      if ( obsPhoto?.photo ) {
        return Photo.displayLocalOrRemoteLargePhoto( obsPhoto.photo ) || imageUri || null;
      }
    }
    return imageUri || null;
  }, [context, currentObservation, imageUri, observationPhotoUuid] );

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
      <View className="flex-1 bg-black">
        <View className="absolute top-8 left-0">
          <BackButton color={colors.white} onPress={( ) => navigation.goBack( )} />
        </View>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={colors.white} />
        </View>
      </View>
    );
  }

  return (
    <ImageCropView
      sourceUri={localImageUri}
      imageWidth={imageSize.w}
      imageHeight={imageSize.h}
      initialCrop={activeInitialCrop}
      labels={labels}
      brightnessLogKey={brightnessLogKey}
      onConfirm={handleConfirm}
      onDelete={handleDelete}
    />
  );
};

export default ImageCropEditor;
