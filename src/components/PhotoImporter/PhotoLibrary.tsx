import {
  copyAssetsFileIOS, copyFile, mkdir, unlink,
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
  buildGroupedSoundItem,
} from "components/PhotoImporter/helpers/photoLibraryMediaHelpers";
import {
  extractVideoMedia,
  isVideoNode,
} from "components/PhotoImporter/helpers/videoImportHelpers";
import PhotoGallery from "components/PhotoImporter/PhotoGallery";
import { ViewWrapper } from "components/SharedComponents";
import type { NoBottomTabStackScreenProps, TabStackScreenProps } from "navigation/types";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback,
} from "react";
import {
  Alert, NativeModules, Platform,
} from "react-native";
import type { Asset } from "react-native-image-picker";
import { markDuplicatePhotosFromLibrary } from "sharedHelpers/duplicateUploadedDevicePhotos";
import { getOriginalDevicePhotoUrisFromAssets } from "sharedHelpers/getOriginalDevicePhotoUri";
import { log } from "sharedHelpers/logger";
import { useInputImageTracking, useTranslation } from "sharedHooks";
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
  // This screen is registered in both stacks (see PhotoImporterStackScreens),
  // so navigate to GroupPhotos unqualified and let it resolve in whichever
  // stack the import was started from.
  const navigation = useNavigation<
    NoBottomTabStackScreenProps<"PhotoLibrary">["navigation"] &
    TabStackScreenProps<"PhotoLibrary">["navigation"]
  >( );
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
  const { t } = useTranslation( );

  const skipGroupPhotos = params?.skipGroupPhotos ?? false;
  const fromGroupPhotos = params?.fromGroupPhotos ?? false;
  const fromAICamera = params?.fromAICamera ?? false;

  const navToObsEdit = useCallback( ( ) => navigation.navigate( "ObsEdit", {
    lastScreen: "PhotoLibrary",
  } ), [navigation] );

  const handleSelectionCancelled = useCallback( ( ) => {
    if ( fromGroupPhotos ) {
      navigation.navigate( "GroupPhotos" );
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

  const copyImagesFromCameraRoll = useCallback( async (
    nodes: PhotoNode[],
    onPhotoSettled?: ( succeeded: boolean ) => void,
  ) => {
    const path = photoLibraryPhotosPath;
    await mkdir( path );

    // Every node for a given asset resolves to the same destination path, so
    // copying one twice in a batch has the two writes racing over the same
    // file (each unlinking what the other just wrote) and both fail with
    // "PHPhotosErrorDomain error -1", dropping the photo from the import.
    const uniqueNodes = [...new Map(
      nodes.map( node => [node.image.uri, node] ),
    ).values( )];

    // Distinct assets can still collide on a destination, since two of them
    // can carry the same filename (e.g. IMG_0001.JPG from two cameras).
    const claimedFileNames = new Set<string>( );

    const copyNode = async ( node: PhotoNode ) => {
      let fileName = node.image.filename ?? `${uuid.v4()}.jpg`;
      if ( claimedFileNames.has( fileName ) ) {
        fileName = `${uuid.v4()}-${fileName}`;
      }
      claimedFileNames.add( fileName );
      const destPath = `${path}/${fileName}`;
      // Remove any file left by a previous import of the same asset. Both
      // PHAssetResourceManager.writeData (iOS) and copyFile (Android) fail if
      // the destination already exists — iOS surfaces this as the opaque
      // "PHPhotosErrorDomain error -1", which was aborting the whole import
      // when a still-selected, already-imported photo was re-imported.
      await unlink( destPath ).catch( ( ) => undefined );
      if ( Platform.OS === "ios" ) {
        // Use PHAssetResourceManager.writeData (via ImageCropper.exportPHAsset)
        // to write the original file bytes verbatim — no decode/re-encode,
        // so all EXIF (GPS, timestamp, camera details) is preserved.
        const { ImageCropper } = NativeModules as {
          ImageCropper?: {
            exportPHAsset: (
              phUri: string,
              destPath: string
            ) => Promise<{ uri: string; attempts: number }>;
          };
        };
        if ( ImageCropper?.exportPHAsset ) {
          const { attempts } = await ImageCropper.exportPHAsset( node.image.uri, destPath );
          // A retry succeeding is itself worth knowing: it confirms failed
          // imports are a slow/flaky iCloud download, not a hard failure.
          // The ph:// URI identifies the user's photo and belongs in a shared
          // log no more than the coordinates do; the attempt count is the
          // information.
          if ( attempts > 1 ) {
            logger.info( `Exported a photo after ${attempts} attempt(s)` );
          }
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
      const sourceAsset = nodeToSourceAsset( node );
      return {
        image: {
          ...sourceAsset,
          uri: `file://${destPath}`,
        },
        // Carried alongside so callers can pair a copy with the device asset it
        // came from by value. Pairing them by index breaks as soon as one photo
        // in the batch fails to copy, and mismatched pairs attach the wrong
        // ph:// URI to a photo — which is what later gets deleted from the
        // device and recorded as uploaded.
        sourceAsset,
      };
    };

    // A single flaky asset (e.g. an iCloud photo whose bytes fail to download,
    // surfaced as the opaque "PHPhotosErrorDomain error -1") must not abort
    // the whole batch — that previously rejected the entire import and threw
    // the user out of the observation flow even when most photos copied fine.
    const copyNodeOrNull = async ( node: PhotoNode ) => {
      try {
        const copied = await copyNode( node );
        // Report failures as settled too: the progress bar tracks how much of
        // the wait is left, and a failed copy is over just as a good one is.
        onPhotoSettled?.( true );
        return copied;
      } catch ( error ) {
        logger.error( "Error copying a photo from camera roll", error );
        onPhotoSettled?.( false );
        return null;
      }
    };

    const BATCH_SIZE = 10;
    const results = [];
    for ( let i = 0; i < uniqueNodes.length; i += BATCH_SIZE ) {
      const batch = uniqueNodes.slice( i, i + BATCH_SIZE );
      // eslint-disable-next-line no-await-in-loop
      const batchResults = await Promise.all( batch.map( copyNodeOrNull ) );
      results.push( ...batchResults.filter( ( r ): r is NonNullable<typeof r> => r !== null ) );
    }
    if ( results.length < uniqueNodes.length ) {
      logger.warn( `Copied ${results.length} of ${uniqueNodes.length} photo(s) from camera roll` );
    }
    return results;
  }, [] );

  const handleGalleryDone = useCallback( async (
    nodes: PhotoNode[],
    onProgress?: ( completed: number, failed: number ) => void,
  ) => {
    try {
      const videoNodes = nodes.filter( isVideoNode );
      const photoNodes = nodes.filter( n => !isVideoNode( n ) );

      // One tick per selected item, videos included, so the caller's progress
      // bar advances over the whole import and not just the copying phase.
      // Failures are counted separately: a photo whose bytes never arrive
      // (an iCloud asset that won't download) is otherwise invisible until the
      // user notices it missing from the next screen.
      let settled = 0;
      let failed = 0;
      const reportSettled = ( succeeded: boolean ) => {
        settled += 1;
        if ( !succeeded ) failed += 1;
        onProgress?.( settled, failed );
      };

      // Extract GIF + audio from each video node and build GroupedMediaItems
      // so they appear in the GroupPhotos screen alongside regular photos.
      const videoGroupItems = [];
      for ( const videoNode of videoNodes ) {
        // eslint-disable-next-line no-await-in-loop
        const { gifUri, audioUri } = await extractVideoMedia( videoNode );
        if ( gifUri ) {
          videoGroupItems.push( {
            photos: [
              {
                image: {
                  uri: gifUri,
                  type: "image/gif",
                  fileName: gifUri.split( "/" ).pop( ),
                  width: videoNode.image.width,
                  height: videoNode.image.height,
                  fileSize: undefined,
                  id: undefined,
                  timestamp: videoNode.timestamp,
                },
              },
            ],
          } );
        }
        if ( audioUri ) {
          videoGroupItems.push(
            buildGroupedSoundItem( audioUri, videoNode.timestamp ),
          );
        }
        // A video that yields neither a GIF nor audio contributed nothing to
        // the import, so count it the same as a photo that failed to copy.
        reportSettled( !!gifUri || !!audioUri );
      }

      const copiedPhotos = photoNodes.length > 0
        ? await copyImagesFromCameraRoll( photoNodes, reportSettled )
        : [];

      // Only photos that actually copied are staged for the "delete the
      // originals?" prompt on exit. Staging every selected photo up front
      // offered to delete originals whose copy had failed, leaving the photo
      // gone from the device with nothing imported to show for it.
      addOriginalDevicePhotoUris( getOriginalDevicePhotoUrisFromAssets(
        copiedPhotos.map( photo => photo.sourceAsset ),
      ) );

      const selectedPhotos = copiedPhotos.length > 0
        ? markDuplicatePhotosFromLibrary(
          realm,
          copiedPhotos,
          copiedPhotos.map( photo => photo.sourceAsset ),
        )
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

      // Every copy failing leaves nothing to hand on, and navigating onward
      // anyway lands the user on an empty Group Photos screen — or, coming
      // from Group Photos, right back where they started, which is
      // indistinguishable from the check doing nothing at all. Say what
      // happened and stay put so the selection survives a retry.
      if ( photoNodes.length > 0 && !hasPhotos && videoGroupItems.length === 0 ) {
        logger.error( `Imported none of the ${photoNodes.length} selected photo(s)` );
        Alert.alert(
          t( "Something-went-wrong" ),
          t( "Could-not-import-selected-photos" ),
        );
        return;
      }

      if ( fromGroupPhotos ) {
        setGroupedPhotos( sortGroupsByTime( [
          ...groupedPhotos,
          ...videoGroupItems,
          ...buildGroupedMediaItems( selectedPhotos ),
        ] ) );
        navigation.setParams( { fromGroupPhotos: false } );
        navigation.navigate( "GroupPhotos" );
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
        groupedPhotos: sortGroupsByTime( [
          ...videoGroupItems,
          ...buildGroupedMediaItems( selectedPhotos ),
        ] ),
      } );
      navigation.setParams( { fromGroupPhotos: false } );
      navigation.navigate( "GroupPhotos" );
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
    t,
    trackImagesLoaded,
    updateObservations,
  ] );

  return (
    <ViewWrapper testID="PhotoLibrary">
      <PhotoGallery
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
