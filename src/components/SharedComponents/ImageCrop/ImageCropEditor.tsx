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
// How many of those to also decode off-screen (see ImageCropView's warmUris).
// Fewer than the lookahead: a decoded photo sits in memory, and one photo of
// slack is enough to cover the time it takes to crop the current one.
const DECODE_LOOKAHEAD = 2;
// Above this, the wait for a photo is long enough for the user to see a
// spinner, and worth a line in the app log saying which stage it went on.
// Below it, logging every photo of a 200-photo bulk crop would say nothing.
const SLOW_PHOTO_MS = 400;

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
  const cropImport = params?.cropImport ?? false;

  // The photo currently being cropped and the rest of the bulk crop queue.
  // Held in state rather than read from route params on every render because a
  // bulk crop advances by swapping these in place (see finishOrAdvance).
  const [imageUri, setImageUri] = useState( params?.imageUri );
  const [pendingImageUris, setPendingImageUris] = useState<string[]>(
    params?.pendingImageUris ?? [],
  );

  // Cropping a whole import (cropImport) takes its queue from the store rather
  // than a fixed list of uris, because the photos are still being copied out
  // of the library while the user crops: a photo joins the queue when its file
  // lands. Photos already in the grid before this batch was picked, and the
  // ones this editor has already shown, are what it has to skip.
  const [visitedUris, setVisitedUris] = useState<Set<string>>( ( ) => new Set( [
    ...( params?.skipUris ?? [] ),
    ...( params?.imageUri
      ? [params.imageUri]
      : [] ),
  ] ) );
  const markVisited = useCallback( ( uri: string ) => setVisitedUris( uris => ( uris.has( uri )
    ? uris
    : new Set( uris ).add( uri ) ) ), [] );
  const importedUris = useMemo( ( ) => ( cropImport
    ? groupedPhotos.flatMap( group => ( group.photos ?? [] )
      .filter( photo => !photo.pending )
      .map( photo => photo.image.uri )
      // The GIF an imported video was turned into: cropping it would write a
      // single still frame back over the animation
      .filter( uri => !uri.toLowerCase( ).endsWith( ".gif" ) ) )
    : [] ), [cropImport, groupedPhotos] );
  const importIsPending = useMemo( ( ) => cropImport && groupedPhotos.some(
    group => ( group.photos ?? [] ).some( photo => photo.pending ),
  ), [cropImport, groupedPhotos] );
  const nextImportUri = importedUris.find( uri => !visitedUris.has( uri ) );

  // An import queue has nothing to show before its first photo has been copied,
  // or between photos while the rest are still copying. Take the next photo the
  // store has during render, like the preload seed below, so a photo that has
  // already landed is never behind a frame of spinner.
  if ( cropImport && !imageUri && nextImportUri ) {
    markVisited( nextImportUri );
    setImageUri( nextImportUri );
  }

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
  // What the cropper draws: the display-sized file the preload decoded out of
  // the original. The crop is still applied to localImageUri, and both describe
  // the same frame, so every transform below is unaffected by the difference.
  const [displayImageUri, setDisplayImageUri] = useState<string | null>( null );
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>( null );
  const [detectedCrop, setDetectedCrop] = useState<NormalizedCrop | null>( null );
  const [savedInitialCrop, setSavedInitialCrop] = useState<NormalizedCrop | null>( null );
  const [loadingSource, setLoadingSource] = useState( true );
  const [seededUri, setSeededUri] = useState<string | null>( null );

  // When the editor switched to this photo, and whether its preload had
  // already finished by then -- the two things that decide whether advancing a
  // bulk crop shows a spinner at all. Reported once the photo is on screen.
  const shownAt = useRef( 0 );
  const shownFromCache = useRef( false );
  const loggedWaitFor = useRef<string | null>( null );

  // Seed state from the preload cache during render, before the first paint of
  // each image, so mounting the editor (and advancing to the next photo in a
  // bulk crop) shows an already-preloaded image immediately instead of painting
  // a spinner, or the previous photo, while the async effect below re-reads the
  // same cached data.
  if ( imageUri && seededUri !== imageUri ) {
    setSeededUri( imageUri );
    const cached = preloadCache.get( imageUri );
    shownAt.current = Date.now( );
    shownFromCache.current = !!cached;
    const { existingSavedCrop } = resolveCropContext( );
    setLocalImageUri( cached?.localUri ?? null );
    setDisplayImageUri( cached?.displayUri ?? null );
    setImageSize( cached?.size ?? null );
    setSavedInitialCrop( cached
      ? existingSavedCrop
      : null );
    setDetectedCrop( cached
      ? existingSavedCrop ?? cached.crop
      : null );
    setLoadingSource( !cached );
  }

  // One line per photo the user actually waited on, saying how the wait split
  // between the preload's stages and the decode -- the wait between photos in
  // a bulk crop is whatever of that was still outstanding when they advanced.
  const handleDecoded = useCallback( ( decodeMs: number ) => {
    if ( !imageUri || loggedWaitFor.current === imageUri || !shownAt.current ) {
      return;
    }
    loggedWaitFor.current = imageUri;
    const totalMs = Date.now( ) - shownAt.current;
    if ( totalMs < SLOW_PHOTO_MS ) {
      return;
    }
    const timing = preloadCache.get( imageUri )?.timing;
    logger.infoWithExtra( "crop_photo_slow", {
      totalMs,
      decodeMs,
      // A photo whose preload had landed before the user advanced starts with
      // everything it needs, so anything left is decode and paint.
      preloaded: shownFromCache.current,
      // How long before the editor needed it the preload finished. Negative
      // means the photo was asked for before its load was done, and the
      // difference is what the spinner was for.
      readyMs: timing
        ? shownAt.current - timing.finishedAt
        : null,
      exportMs: timing?.exportMs ?? null,
      prepareMs: timing?.prepareMs ?? null,
    } );
  }, [imageUri] );

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

  // Local files of the upcoming photos whose preload has finished, handed to
  // ImageCropView so it can decode them before the user advances.
  const [warmUris, setWarmUris] = useState<string[]>( [] );

  const applyPreloadResult = useCallback( (
    result: PreloadResult,
    existingSavedCrop: NormalizedCrop | null,
  ) => {
    setLocalImageUri( result.localUri );
    setDisplayImageUri( result.displayUri );
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
          setDisplayImageUri( null );
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
    const upcomingUris = cropImport
      ? importedUris.filter( uri => !visitedUris.has( uri ) )
      : pendingImageUris;
    const setWarmUrisTo = ( uris: string[] ) => setWarmUris(
      prev => ( prev.length === uris.length && prev.every( ( u, i ) => u === uris[i] )
        ? prev
        : uris ),
    );
    if ( !upcomingUris.length || context !== "groupPhotos" ) {
      // Nothing left to come: stop holding the last photos in memory.
      setWarmUrisTo( [] );
      return ( ) => {};
    }
    let cancelled = false;
    // Hand ImageCropView whichever of the next photos are ready to decode. Runs
    // again as each preload lands, so a photo starts decoding as soon as its
    // file exists rather than waiting for the whole lookahead.
    const syncWarmUris = ( ) => {
      if ( cancelled ) {
        return;
      }
      const uris = upcomingUris
        .slice( 0, DECODE_LOOKAHEAD )
        .map( uri => preloadCache.get( uri )?.displayUri )
        .filter( ( uri ): uri is string => !!uri );
      setWarmUrisTo( uris );
    };
    // enqueuePreload dedupes against its cache, its in-flight loads and its
    // queue, so re-enqueueing on every re-run costs nothing.
    const preload = ( uri: string ) => {
      const groupedPhoto = findGroupedPhotoByDisplayUri( groupedPhotos, uri );
      const cropSourceUri = groupedPhoto?.image.cropOriginalUri || uri;
      const existingSavedCrop = groupedPhoto?.image.crop ?? null;
      enqueuePreload( uri, cropSourceUri, existingSavedCrop ).then( syncWarmUris, ( ) => {} );
    };
    syncWarmUris( );
    preload( upcomingUris[0] );
    const handle = InteractionManager.runAfterInteractions( ( ) => {
      upcomingUris.slice( 1, PRELOAD_LOOKAHEAD ).forEach( preload );
    } );
    return ( ) => {
      cancelled = true;
      handle.cancel( );
    };
  }, [context, cropImport, groupedPhotos, importedUris, pendingImageUris, visitedUris] );

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
    if ( cropImport ) {
      // Whichever photo comes next is picked during render: the next one the
      // import has landed, or none while the rest are still copying.
      if ( imageUri ) {
        markVisited( imageUri );
      }
      setImageUri( undefined );
      return;
    }
    onCropSaved?.( );
    navigation.goBack( );
  }, [
    cropImport,
    imageUri,
    markVisited,
    navigation,
    onCropSaved,
    pendingImageUris,
  ] );

  // The import has nothing left to crop: the last photo has been cropped, or
  // the ones the user was waiting on failed to copy.
  useEffect( ( ) => {
    if ( !cropImport || imageUri || importIsPending || nextImportUri ) {
      return;
    }
    onCropSaved?.( );
    navigation.goBack( );
  }, [
    cropImport,
    imageUri,
    importIsPending,
    navigation,
    nextImportUri,
    onCropSaved,
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
          // Same as removing from the Group Photos grid: record it rather than
          // deleting it, so the photo stays hidden from the photo picker and
          // can be deleted later from Photo Cleanup (removedGroupPhotoUris.ts).
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
        // Cropping replaces the photo's uri in the store with the cropped
        // file's, which an import queue reading the store would otherwise
        // take for a photo it hasn't shown yet and come back to.
        await applyGroupPhotosCrop( crop, displayUri, sourceUri, size, markVisited );
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

          const photoUrl = Photo.displayLocalOrRemoteOriginalPhoto( existingPhoto );
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
    markVisited,
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
        return Photo.displayLocalOrRemoteOriginalPhoto( obsPhoto.photo ) || imageUri || null;
      }
    }
    return imageUri || null;
  }, [context, currentObservation, imageUri, observationPhotoUuid] );

  // Between photos of an import: the same black screen the cropper loads
  // behind, rather than a dead end offering a way back, while the next photo
  // is copied or the editor closes on the last one.
  if ( !imageUri && cropImport ) {
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

  if ( loadingSource || !localImageUri || !displayImageUri || !imageSize || !activeInitialCrop ) {
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
      sourceUri={displayImageUri}
      imageWidth={imageSize.w}
      imageHeight={imageSize.h}
      initialCrop={activeInitialCrop}
      labels={labels}
      brightnessLogKey={brightnessLogKey}
      warmUris={warmUris}
      onDecoded={handleDecoded}
      onConfirm={handleConfirm}
      onDelete={handleDelete}
    />
  );
};

export default ImageCropEditor;
