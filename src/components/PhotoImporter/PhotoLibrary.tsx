import { mkdir, moveFile, TemporaryDirectoryPath } from "@dr.pogodin/react-native-fs";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import {
  photoLibraryPhotosPath,
} from "appConstants/paths";
import navigateToObsDetails from "components/ObsDetails/helpers/navigateToObsDetails";
import {
  appendPhotosAndVideoSoundsToObservation,
  buildGroupedMediaItems,
  createObservationWithVideoSounds,
  partitionAssetsByMediaType,
} from "components/PhotoImporter/helpers/photoLibraryMediaHelpers";
import { ActivityAnimation, ViewWrapper } from "components/SharedComponents";
import { t } from "i18next";
import type { NoBottomTabStackScreenProps } from "navigation/types";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback,
  useState,
} from "react";
import {
  InteractionManager,
  Platform,
  View,
} from "react-native";
import type { Asset } from "react-native-image-picker";
import { launchImageLibrary } from "react-native-image-picker";
import Observation from "realmModels/Observation";
import { markDuplicatePhotosFromLibrary } from "sharedHelpers/duplicateUploadedDevicePhotos";
import fetchPlaceName from "sharedHelpers/fetchPlaceName";
import { getOriginalDevicePhotoUrisFromAssets } from "sharedHelpers/getOriginalDevicePhotoUri";
import { log } from "sharedHelpers/logger";
import { populateObservationTaxonFromFirstPhoto } from "sharedHelpers/predictTopTaxonFromPhoto";
import { sleep } from "sharedHelpers/util";
import { useInputImageTracking, useLayoutPrefs } from "sharedHooks";
import useExitObservationFlow from "sharedHooks/useExitObservationFlow";
import useStore from "stores/useStore";

const logger = log.extend( "PhotoLibrary" );

const { useRealm } = RealmContext;

const MAX_PHOTOS_ALLOWED = Platform.select( {
  ios: 500,
  android: 100,
} );

const FROM_AICAMERA_MAX_PHOTOS_ALLOWED = 1;

const PhotoLibrary = ( ) => {
  const {
    screenAfterPhotoEvidence, isDefaultMode,
  } = useLayoutPrefs( );
  const navigation = useNavigation<NoBottomTabStackScreenProps<"PhotoLibrary">["navigation"]>();
  const { params } = useRoute<NoBottomTabStackScreenProps<"PhotoLibrary">["route"]>();

  const [photoLibraryShown, setPhotoLibraryShown] = useState( false );
  const setPhotoImporterState = useStore( state => state.setPhotoImporterState );
  const addOriginalDevicePhotoUris = useStore( state => state.addOriginalDevicePhotoUris );
  const addImportedPhotoDeviceUriMappings = useStore(
    state => state.addImportedPhotoDeviceUriMappings,
  );
  const setGroupedPhotos = useStore( state => state.setGroupedPhotos );
  const groupedPhotos = useStore( state => state.groupedPhotos );
  const updateObservations = useStore( state => state.updateObservations );
  const photoLibraryUris = useStore( state => state.photoLibraryUris );
  const evidenceToAdd = useStore( state => state.evidenceToAdd );
  const currentObservation = useStore( state => state.currentObservation );
  const currentObservationIndex = useStore( state => state.currentObservationIndex );
  const observations = useStore( state => state.observations );
  const numOfObsPhotos: number = currentObservation?.observationPhotos?.length || 0;
  const exitObservationFlow = useExitObservationFlow( );
  const realm = useRealm( );
  const { trackImageLoaded } = useInputImageTracking( );

  const skipGroupPhotos = params
    ? params.skipGroupPhotos
    : false;
  const fromGroupPhotos = params
    ? params.fromGroupPhotos
    : false;
  const fromAICamera = params
    ? params.fromAICamera
    : false;

  const navToObsEdit = useCallback( ( ) => navigation.navigate( "ObsEdit", {
    lastScreen: "PhotoLibrary",
  } ), [navigation] );

  const navBasedOnUserSettings = useCallback( async ( ) => {
    if ( isDefaultMode ) {
      // TODO: why do we need to define higher navigator here
      return navigation.navigate( "NoBottomTabStackNavigator", {
        screen: "Match",
        params: {
          lastScreen: "PhotoLibrary",
        },
      } );
    }

    // in advanced mode, navigate based on user preference
    return navigation.navigate( "NoBottomTabStackNavigator", {
      screen: screenAfterPhotoEvidence,
      params: {
        lastScreen: "PhotoLibrary",
      },
    } );
  }, [navigation, screenAfterPhotoEvidence, isDefaultMode] );

  const handleSelectionCancelled = useCallback( ( ) => {
    if ( fromGroupPhotos ) {
      navigation.navigate( "NoBottomTabStackNavigator", { screen: "GroupPhotos" } );
      navigation.setParams( { fromGroupPhotos: false } );
    } else if ( skipGroupPhotos ) {
      navToObsEdit();
    } else if ( params && params.previousScreen && params.previousScreen.name === "ObsDetails" ) {
      if ( !params.previousScreen.params?.uuid ) {
        throw new Error( "No UUID found to route to ObsDetails screen" );
      }
      navigateToObsDetails( navigation, params.previousScreen.params.uuid );
    } else if ( params?.cmonBack && navigation.canGoBack() ) {
      navigation.goBack();
    } else {
      exitObservationFlow( );
    }
    setPhotoLibraryShown( false );
  }, [
    exitObservationFlow,
    fromGroupPhotos,
    navToObsEdit,
    navigation,
    params,
    skipGroupPhotos,
  ] );

  const moveImagesToDocumentsDirectory = async ( selectedImages:
    { image: Asset }[] ) => {
    const path = photoLibraryPhotosPath;
    await mkdir( path );

    const movedImages = await Promise.all( selectedImages.map( async ( { image } ) => {
      const { fileName, uri } = image;
      if ( !fileName ) {
        throw new Error( "No fileName in pick photo response" );
      }
      const destPath = `${path}/${fileName}`;
      const getSourcePath = Platform.select( {
        ios: ( ) => `${TemporaryDirectoryPath}/${fileName}`,
        // Get image from uri on android. TemporaryDirectoryPath results in an ANR.
        android: ( ) => {
          if ( !uri ) {
            throw new Error( "No URI in pick photo response" );
          }
          return uri;
        },
        default: ( ) => {
          throw new Error( `Unsupported platform for moving picked photo: ${Platform.OS}` );
        },
      } );

      await moveFile( getSourcePath(), destPath );
      return {
        image: {
          ...image,
          uri: Platform.OS === "ios"
            ? `file://${destPath}`
            : destPath,
        },
      };
    } ) );
    return movedImages;
  };

  const buildMovedVideos = useCallback( (
    selectedVideos: { image: Asset }[],
    videoAssets: Asset[],
  ) => selectedVideos.map( ( { image }, index ) => ( {
    uri: image.uri,
    asset: {
      ...videoAssets[index],
      ...image,
    },
  } ) ), [] );

  const finalizeNewObservation = useCallback( async (
    newObservation: Awaited<ReturnType<typeof createObservationWithVideoSounds>>,
    hasPhotos: boolean,
  ) => {
    if ( newObservation.latitude ) {
      const placeName = await fetchPlaceName(
        newObservation.latitude,
        newObservation.longitude,
      );
      newObservation.place_guess = placeName;
    }

    if ( hasPhotos ) {
      await populateObservationTaxonFromFirstPhoto( newObservation, realm );
    }

    setPhotoImporterState( {
      observations: [newObservation],
    } );

    if ( hasPhotos && !newObservation.observationSounds?.length ) {
      navBasedOnUserSettings( );
    } else {
      navToObsEdit( );
    }
    setPhotoLibraryShown( false );
  }, [navBasedOnUserSettings, navToObsEdit, realm, setPhotoImporterState] );

  const showPhotoLibrary = useCallback( async () => {
    if ( photoLibraryShown ) {
      return;
    }

    setPhotoLibraryShown( true );

    if ( Platform.OS === "ios" ) {
      // iOS has annoying transition of the screen - that if we don't wait enough time,
      // the launchImageLibrary would halt and not return (and not showing any image picker)
      await sleep( 500 );
    }

    let response;
    try {
      response = await launchImageLibrary( {
        selectionLimit: fromAICamera
          ? FROM_AICAMERA_MAX_PHOTOS_ALLOWED
          : MAX_PHOTOS_ALLOWED,
        mediaType: fromAICamera
          ? "photo"
          : "mixed",
        includeBase64: false,
        includeExtra: !fromAICamera,
        // forceOldAndroidPhotoPicker is necessary because the "new" picker strips key EXIF data
        forceOldAndroidPhotoPicker: true,
        chooserTitle: t( "Import-Photos-From" ),
        presentationStyle: "overFullScreen",
      } );
    } catch ( launchError ) {
      logger.error( "launchImageLibrary threw unexpectedly", launchError );
      setPhotoLibraryShown( false );
      exitObservationFlow( );
      return;
    }

    if ( !response || response.didCancel || !response.assets || response.errorCode ) {
      if ( response?.errorCode ) {
        logger.error(
          `import from photo library error: ${response.errorCode}: ${response.errorMessage}`,
        );
      }

      handleSelectionCancelled();
      return;
    }

    try {
      const { photoAssets, videoAssets } = partitionAssetsByMediaType( response.assets );
      addOriginalDevicePhotoUris(
        getOriginalDevicePhotoUrisFromAssets( response.assets ),
      );

      const movedPhotos = photoAssets.length > 0
        ? await moveImagesToDocumentsDirectory( photoAssets.map( image => ( { image } ) ) )
        : [];
      const selectedPhotos = movedPhotos.length > 0
        ? markDuplicatePhotosFromLibrary( realm, movedPhotos, photoAssets )
        : [];
      if ( selectedPhotos.length > 0 ) {
        addImportedPhotoDeviceUriMappings(
          selectedPhotos.map( photo => ( {
            localUri: photo.image.uri,
            deviceUri: photo.originalDevicePhotoUri,
          } ) ),
        );
        selectedPhotos.forEach( ( { image } ) => {
          if ( image.uri ) {
            trackImageLoaded( image.uri, "photoLibrary" );
          }
        } );
      }
      const selectedVideos = videoAssets.length > 0
        ? await moveImagesToDocumentsDirectory( videoAssets.map( image => ( { image } ) ) )
        : [];
      const movedVideos = buildMovedVideos( selectedVideos, videoAssets );
      const hasPhotos = selectedPhotos.length > 0;
      const hasVideos = movedVideos.length > 0;

      if ( fromGroupPhotos ) {
        setGroupedPhotos( [
          ...groupedPhotos,
          ...buildGroupedMediaItems( selectedPhotos, movedVideos ),
        ] );
        navigation.setParams( { fromGroupPhotos: false } );
        navigation.navigate( "NoBottomTabStackNavigator", { screen: "GroupPhotos" } );
        setPhotoLibraryShown( false );
        return;
      }

      if ( skipGroupPhotos ) {
        if ( hasPhotos ) {
          const importedPhotoUris = selectedPhotos.map( x => x.image.uri );
          setPhotoImporterState( {
            photoLibraryUris: [...photoLibraryUris, ...importedPhotoUris],
            evidenceToAdd: [...evidenceToAdd, ...importedPhotoUris],
          } );
        }

        const updatedCurrentObservation = await appendPhotosAndVideoSoundsToObservation(
          selectedPhotos,
          movedVideos,
          currentObservation,
          numOfObsPhotos,
        );

        const updatedObservations = [...observations];
        updatedObservations[currentObservationIndex] = updatedCurrentObservation;
        updateObservations( updatedObservations );

        navToObsEdit();
        setPhotoLibraryShown( false );
        return;
      }

      const totalMediaCount = selectedPhotos.length + movedVideos.length;

      if ( totalMediaCount === 1 ) {
        if ( hasVideos ) {
          const newObservation = await createObservationWithVideoSounds( movedVideos );
          await finalizeNewObservation( newObservation, false );
        } else {
          const newObservation = await Observation.createObservationWithPhotos(
            [selectedPhotos[0]],
          );
          await finalizeNewObservation( newObservation, true );
        }
        return;
      }

      const importedPhotoUris = selectedPhotos.map( x => x.image.uri );

      setPhotoImporterState( {
        photoLibraryUris: [...photoLibraryUris, ...importedPhotoUris],
        groupedPhotos: buildGroupedMediaItems( selectedPhotos, movedVideos ),
      } );
      navigation.setParams( { fromGroupPhotos: false } );
      navigation.navigate( "NoBottomTabStackNavigator", { screen: "GroupPhotos" } );
      setPhotoLibraryShown( false );
    } catch ( error ) {
      logger.error( "Error importing photos from library", error );
      setPhotoLibraryShown( false );
      exitObservationFlow( );
    }
  }, [
    addImportedPhotoDeviceUriMappings,
    addOriginalDevicePhotoUris,
    buildMovedVideos,
    currentObservation,
    currentObservationIndex,
    evidenceToAdd,
    exitObservationFlow,
    finalizeNewObservation,
    fromAICamera,
    fromGroupPhotos,
    groupedPhotos,
    handleSelectionCancelled,
    navToObsEdit,
    navigation,
    numOfObsPhotos,
    observations,
    photoLibraryShown,
    photoLibraryUris,
    realm,
    setGroupedPhotos,
    setPhotoImporterState,
    skipGroupPhotos,
    trackImageLoaded,
    updateObservations,
  ] );

  useFocusEffect(
    React.useCallback( () => {
      let interactionHandle = null;

      interactionHandle = InteractionManager.runAfterInteractions( () => {
        if ( !photoLibraryShown ) {
          showPhotoLibrary();
        }
      } );

      return () => {
        if ( interactionHandle ) {
          interactionHandle.cancel();
        }
      };
    }, [photoLibraryShown, showPhotoLibrary] ),
  );

  return (
    <ViewWrapper testID="PhotoLibrary">
      <View className="flex-1 w-full h-full justify-center items-center">
        <ActivityAnimation />
      </View>
    </ViewWrapper>
  );
};

export default PhotoLibrary;
