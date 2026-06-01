import { useNavigation, useRoute } from "@react-navigation/native";
import navigateToObsDetails from "components/ObsDetails/helpers/navigateToObsDetails";
import {
  appendPhotosAndVideoSoundsToObservation,
  buildGroupedMediaItems,
  createObservationWithVideoSounds,
  partitionAssetsByMediaType,
} from "components/PhotoImporter/helpers/photoLibraryMediaHelpers";
import type { NoBottomTabStackScreenProps } from "navigation/types";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback,
} from "react";
import {
  Platform,
} from "react-native";
import type { Asset } from "react-native-image-picker";
import Observation from "realmModels/Observation";
import { markDuplicatePhotosFromLibrary } from "sharedHelpers/duplicateUploadedDevicePhotos";
import fetchPlaceName from "sharedHelpers/fetchPlaceName";
import { getOriginalDevicePhotoUrisFromAssets } from "sharedHelpers/getOriginalDevicePhotoUri";
import { log } from "sharedHelpers/logger";
import { populateObservationTaxonFromFirstPhoto } from "sharedHelpers/predictTopTaxonFromPhoto";
import { useInputImageTracking, useLayoutPrefs } from "sharedHooks";
import useExitObservationFlow from "sharedHooks/useExitObservationFlow";
import useStore from "stores/useStore";

import CustomPhotoLibrary from "./CustomPhotoLibrary/CustomPhotoLibrary";
import {
  copyCameraRollAssetsToDocumentsDirectory,
} from "./CustomPhotoLibrary/helpers/copyCameraRollAssetsToDocumentsDirectory";

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
  const { trackImagesLoaded } = useInputImageTracking( );

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
      return navigation.navigate( "NoBottomTabStackNavigator", {
        screen: "Match",
        params: {
          lastScreen: "PhotoLibrary",
        },
      } );
    }

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
  }, [
    exitObservationFlow,
    fromGroupPhotos,
    navToObsEdit,
    navigation,
    params,
    skipGroupPhotos,
  ] );

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
  }, [navBasedOnUserSettings, navToObsEdit, realm, setPhotoImporterState] );

  const handleConfirm = useCallback( async ( assets: Asset[] ) => {
    try {
      const { photoAssets, videoAssets } = partitionAssetsByMediaType( assets );
      addOriginalDevicePhotoUris(
        getOriginalDevicePhotoUrisFromAssets( assets ),
      );

      const copiedPhotoAssets = photoAssets.length > 0
        ? await copyCameraRollAssetsToDocumentsDirectory( photoAssets )
        : [];
      const movedPhotos = copiedPhotoAssets.map( image => ( { image } ) );
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
        trackImagesLoaded(
          selectedPhotos.map( ( { image } ) => image.uri ).filter( Boolean ) as string[],
          "photoLibrary",
        );
      }

      const copiedVideoAssets = videoAssets.length > 0
        ? await copyCameraRollAssetsToDocumentsDirectory( videoAssets )
        : [];
      const movedVideos = buildMovedVideos(
        copiedVideoAssets.map( image => ( { image } ) ),
        videoAssets,
      );
      const hasPhotos = selectedPhotos.length > 0;
      const hasVideos = movedVideos.length > 0;

      if ( fromGroupPhotos ) {
        setGroupedPhotos( [
          ...groupedPhotos,
          ...buildGroupedMediaItems( selectedPhotos, movedVideos ),
        ] );
        navigation.setParams( { fromGroupPhotos: false } );
        navigation.navigate( "NoBottomTabStackNavigator", { screen: "GroupPhotos" } );
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
    } catch ( error ) {
      logger.error( "Error importing photos from library", error );
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
    fromGroupPhotos,
    groupedPhotos,
    navToObsEdit,
    navigation,
    numOfObsPhotos,
    observations,
    photoLibraryUris,
    realm,
    setGroupedPhotos,
    setPhotoImporterState,
    skipGroupPhotos,
    trackImagesLoaded,
    updateObservations,
  ] );

  return (
    <CustomPhotoLibrary
      assetType={fromAICamera
        ? "photo"
        : "mixed"}
      maxSelection={fromAICamera
        ? FROM_AICAMERA_MAX_PHOTOS_ALLOWED
        : MAX_PHOTOS_ALLOWED}
      onCancel={handleSelectionCancelled}
      onConfirm={handleConfirm}
    />
  );
};

export default PhotoLibrary;
