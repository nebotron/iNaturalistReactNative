import {
  copyAssetsFileIOS, copyFile, mkdir,
} from "@dr.pogodin/react-native-fs";
import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  photoLibraryPhotosPath,
} from "appConstants/paths";
import navigateToObsDetails from "components/ObsDetails/helpers/navigateToObsDetails";
import { sortGroupsByTime } from "components/PhotoImporter/helpers/groupPhotoHelpers";
import {
  appendPhotosToObservation,
  buildGroupedMediaItems,
} from "components/PhotoImporter/helpers/photoLibraryMediaHelpers";
import PhotoGallery from "components/PhotoImporter/PhotoGallery";
import { ViewWrapper } from "components/SharedComponents";
import type { NoBottomTabStackScreenProps } from "navigation/types";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback,
} from "react";
import {
  NativeModules, Platform,
} from "react-native";
import type { Asset } from "react-native-image-picker";
import { markDuplicatePhotosFromLibrary } from "sharedHelpers/duplicateUploadedDevicePhotos";
import { getOriginalDevicePhotoUrisFromAssets } from "sharedHelpers/getOriginalDevicePhotoUri";
import { log } from "sharedHelpers/logger";
import { useInputImageTracking } from "sharedHooks";
import useExitObservationFlow from "sharedHooks/useExitObservationFlow";
import useStore from "stores/useStore";
import * as uuid from "uuid";

type PhotoNode = PhotoIdentifier["node"];

const logger = log.extend( "PhotoLibrary" );

const { useRealm } = RealmContext;

const MAX_PHOTOS_ALLOWED = Platform.select( {
  ios: 500,
  android: 100,
} );

const FROM_AICAMERA_MAX_PHOTOS_ALLOWED = 1;

const nodeToSourceAsset = ( node: PhotoNode ): Asset => ( {
  uri: node.image.uri,
  fileName: node.image.filename ?? undefined,
  width: node.image.width,
  height: node.image.height,
  fileSize: node.image.fileSize ?? undefined,
  type: "image/jpeg",
  id: node.id ?? undefined,
  timestamp: String( node.timestamp ),
} );

const PhotoLibrary = ( ) => {
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

  const skipGroupPhotos = params?.skipGroupPhotos ?? false;
  const fromGroupPhotos = params?.fromGroupPhotos ?? false;
  const fromAICamera = params?.fromAICamera ?? false;

  const navToObsEdit = useCallback( ( ) => navigation.navigate( "ObsEdit", {
    lastScreen: "PhotoLibrary",
  } ), [navigation] );

  const handleSelectionCancelled = useCallback( ( ) => {
    if ( fromGroupPhotos ) {
      navigation.navigate( "NoBottomTabStackNavigator", { screen: "GroupPhotos" } );
      navigation.setParams( { fromGroupPhotos: false } );
    } else if ( skipGroupPhotos ) {
      navToObsEdit();
    } else if ( params?.previousScreen?.name === "ObsDetails" ) {
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

  const copyImagesFromCameraRoll = useCallback( async ( nodes: PhotoNode[] ) => {
    const path = photoLibraryPhotosPath;
    await mkdir( path );

    const copyNode = async ( node: PhotoNode ) => {
      const fileName = node.image.filename ?? `${uuid.v4()}.jpg`;
      const destPath = `${path}/${fileName}`;
      if ( Platform.OS === "ios" ) {
        // Use PHAssetResourceManager.writeData (via ImageCropper.exportPHAsset)
        // to write the original file bytes verbatim — no decode/re-encode,
        // so all EXIF (GPS, timestamp, camera details) is preserved.
        const { ImageCropper } = NativeModules as {
          ImageCropper?: { exportPHAsset: ( phUri: string, destPath: string ) => Promise<string> };
        };
        if ( ImageCropper?.exportPHAsset ) {
          await ImageCropper.exportPHAsset( node.image.uri, destPath );
        } else {
          // Fallback if native module unavailable (re-encodes, may lose EXIF).
          await copyAssetsFileIOS( node.image.uri, destPath, 99999, 99999 );
        }
      } else {
        // On Android 10+, content:// URIs served by MediaStore strip GPS EXIF
        // from the byte stream. Using the actual file path (filepath) bypasses
        // the MediaStore provider and preserves all EXIF metadata.
        const sourceUri = node.image.filepath ?? node.image.uri;
        await copyFile( sourceUri, destPath );
      }
      return {
        image: {
          ...nodeToSourceAsset( node ),
          uri: `file://${destPath}`,
        },
      };
    };

    const BATCH_SIZE = 10;
    const results = [];
    for ( let i = 0; i < nodes.length; i += BATCH_SIZE ) {
      const batch = nodes.slice( i, i + BATCH_SIZE );
      // eslint-disable-next-line no-await-in-loop
      const batchResults = await Promise.all( batch.map( copyNode ) );
      results.push( ...batchResults );
    }
    return results;
  }, [] );

  const handleGalleryDone = useCallback( async ( nodes: PhotoNode[] ) => {
    try {
      const sourceAssets = nodes.map( nodeToSourceAsset );
      addOriginalDevicePhotoUris( getOriginalDevicePhotoUrisFromAssets( sourceAssets ) );

      const copiedPhotos = nodes.length > 0
        ? await copyImagesFromCameraRoll( nodes )
        : [];
      const selectedPhotos = copiedPhotos.length > 0
        ? markDuplicatePhotosFromLibrary( realm, copiedPhotos, sourceAssets )
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
      const hasPhotos = selectedPhotos.length > 0;

      if ( fromGroupPhotos ) {
        setGroupedPhotos( sortGroupsByTime( [
          ...groupedPhotos,
          ...buildGroupedMediaItems( selectedPhotos ),
        ] ) );
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
        const updatedCurrentObservation = await appendPhotosToObservation(
          selectedPhotos,
          currentObservation,
          numOfObsPhotos,
        );
        const updatedObservations = [...observations];
        updatedObservations[currentObservationIndex] = updatedCurrentObservation;
        updateObservations( updatedObservations );
        navToObsEdit();
        return;
      }

      const importedPhotoUris = selectedPhotos.map( x => x.image.uri );
      setPhotoImporterState( {
        photoLibraryUris: [...photoLibraryUris, ...importedPhotoUris],
        groupedPhotos: buildGroupedMediaItems( selectedPhotos ),
      } );
      navigation.setParams( { fromGroupPhotos: false } );
      navigation.navigate( "NoBottomTabStackNavigator", { screen: "GroupPhotos" } );
    } catch ( error ) {
      logger.error( "Error importing photos from camera roll", error );
      exitObservationFlow( );
    }
  }, [
    addImportedPhotoDeviceUriMappings,
    addOriginalDevicePhotoUris,
    copyImagesFromCameraRoll,
    currentObservation,
    currentObservationIndex,
    evidenceToAdd,
    exitObservationFlow,
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
    <ViewWrapper testID="PhotoLibrary">
      <PhotoGallery
        fromAICamera={fromAICamera}
        maxPhotos={fromAICamera
          ? FROM_AICAMERA_MAX_PHOTOS_ALLOWED
          : MAX_PHOTOS_ALLOWED}
        onCancel={handleSelectionCancelled}
        onDone={handleGalleryDone}
      />
    </ViewWrapper>
  );
};

export default PhotoLibrary;
