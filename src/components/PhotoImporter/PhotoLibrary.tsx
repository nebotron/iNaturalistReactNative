import {
  copyFile, mkdir, unlink,
} from "@dr.pogodin/react-native-fs";
import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  photoLibraryPhotosPath,
} from "appConstants/paths";
import navigateToObsDetails from "components/ObsDetails/helpers/navigateToObsDetails";
import { sortGroupsByTime } from "components/PhotoImporter/helpers/groupPhotoHelpers";
import type {
  GroupedMediaItem,
  GroupedMediaPhotoItem,
  ImportedAsset,
} from "components/PhotoImporter/helpers/photoLibraryMediaHelpers";
import {
  appendPhotosToObservation,
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
import { toDevicePhotoLocation } from "sharedHelpers/devicePhotoLocation";
import {
  getPreviouslyUploadedDevicePhotoUrisSet,
  markDuplicatePhotoFromLibrary,
  markDuplicatePhotosFromLibrary,
} from "sharedHelpers/duplicateUploadedDevicePhotos";
import { getOriginalDevicePhotoUrisFromAssets } from "sharedHelpers/getOriginalDevicePhotoUri";
import {
  fileExtension,
  summarizeTypes,
  totalMegabytes,
} from "sharedHelpers/importedFileTypes";
import { log } from "sharedHelpers/logger";
import mapWithConcurrency from "sharedHelpers/mapWithConcurrency";
import {
  clearPhotoImportMarker,
  markPhotoImportStarted,
  updatePhotoImportProgress,
} from "sharedHelpers/photoImportMarker";
import { useInputImageTracking, useLayoutPrefs, useTranslation } from "sharedHooks";
import useExitObservationFlow from "sharedHooks/useExitObservationFlow";
import type { GroupedPhoto, GroupedPhotoResolution } from "stores/createObservationFlowSlice";
import useStore from "stores/useStore";
import * as uuid from "uuid";

type PhotoNode = PhotoIdentifier["node"];

// A photo copied out of the device library: the file the import will use, and
// the device asset it came from.
interface CopiedPhoto {
  // The file the import wrote, so its uri is known to exist unlike the
  // picker's own
  image: ImportedAsset & { uri: string };
  sourceAsset: ImportedAsset;
}

const logger = log.extend( "PhotoLibrary" );

const { useRealm } = RealmContext;

const MAX_PHOTOS_ALLOWED = Platform.select( {
  ios: 500,
  android: 100,
} );

const FROM_AICAMERA_MAX_PHOTOS_ALLOWED = 1;

const nodeToSourceAsset = ( node: PhotoNode ): ImportedAsset & { uri: string } => ( {
  uri: node.image.uri,
  fileName: node.image.filename ?? undefined,
  width: node.image.width,
  height: node.image.height,
  fileSize: node.image.fileSize ?? undefined,
  type: "image/jpeg",
  id: node.id ?? undefined,
  timestamp: String( node.timestamp ),
  // Carried separately from the file: a location set by hand in Photos lives
  // on the asset, not in the photo's EXIF (see devicePhotoLocation.ts).
  deviceLocation: toDevicePhotoLocation( node.location ) ?? undefined,
} );

// The cell Group Photos shows for a selected asset while its file is still
// being copied out of the library. It draws the device library thumbnail, so
// the grid is populated from the moment it opens, and is replaced by the
// imported photo as soon as that lands.
const placeholderGroup = ( node: PhotoNode ): GroupedMediaItem => ( {
  photos: [{ image: nodeToSourceAsset( node ), pending: true }],
} );

const gifPhotoItem = ( node: PhotoNode, gifUri: string ): GroupedMediaPhotoItem => ( {
  image: {
    uri: gifUri,
    type: "image/gif",
    fileName: gifUri.split( "/" ).pop( ),
    width: node.image.width,
    height: node.image.height,
    fileSize: undefined,
    id: undefined,
    timestamp: node.timestamp,
  },
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
  const resolveGroupedPhotoPlaceholder = useStore(
    state => state.resolveGroupedPhotoPlaceholder,
  );
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
  const { isDefaultMode } = useLayoutPrefs( );

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
    onPhotoCopied?: ( node: PhotoNode, copied: CopiedPhoto | null ) => void,
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

    // Which kinds of file the copy could not produce. An import that loses
    // photos loses particular ones — an iCloud-offloaded HEIC behaves nothing
    // like a local JPEG — and the count alone cannot say which.
    const failedExtensions: string[] = [];

    const copyNode = async ( node: PhotoNode ) => {
      let fileName = node.image.filename ?? `${uuid.v4()}.jpg`;
      if ( claimedFileNames.has( fileName ) ) {
        fileName = `${uuid.v4()}-${fileName}`;
      }
      claimedFileNames.add( fileName );
      const destPath = `${path}/${fileName}`;
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
        // No fallback: copyAssetsFileIOS re-encodes, which silently drops EXIF,
        // and a photo imported without its metadata is worse than one the user
        // is told didn't import. copyNodeOrNull counts this as a failed photo.
        if ( !ImageCropper?.exportPHAsset ) {
          throw new Error( "ImageCropper.exportPHAsset is unavailable" );
        }
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
        // Remove any file left by a previous import of the same asset, since
        // copyFile fails if the destination already exists. iOS needs the same
        // clearing, but exportPHAsset already does it before every attempt —
        // doing it from here too was a bridge round trip and a filesystem hit
        // per photo that bought nothing.
        await unlink( destPath ).catch( ( ) => undefined );
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
        onPhotoCopied?.( node, copied );
        return copied;
      } catch ( error ) {
        failedExtensions.push( fileExtension( node.image.filename ) );
        logger.error( "Error copying a photo from camera roll", error );
        // Reported like a successful copy, not swallowed: a caller filling a
        // grid in has to take the cell back out, and a progress bar tracks how
        // much of the wait is left — a failed copy is over just as a good one
        // is.
        onPhotoCopied?.( node, null );
        return null;
      }
    };

    // Ten copies in flight, each slot refilled the moment it frees. This used
    // to await Promise.all over fixed slices of ten, which made every slice as
    // slow as its slowest photo: one iCloud-offloaded asset retrying its
    // download with backoff (2/4/8/16s, then a 60s no-progress watchdog) held
    // the other nine slots idle until it settled, so a few offloaded photos
    // scattered through a selection charged that wait once per slice they
    // landed in. A straggler now costs its own wait and no one else's.
    // mapWithConcurrency keeps the results in selection order, which matters:
    // it decides which photo leads an observation (appendPhotosToObservation)
    // and how the Group Photos screen lays the import out.
    const MAX_COPIES_IN_FLIGHT = 10;
    const results = ( await mapWithConcurrency(
      uniqueNodes,
      MAX_COPIES_IN_FLIGHT,
      copyNodeOrNull,
    ) ).filter( ( r ): r is NonNullable<typeof r> => r !== null );
    if ( results.length < uniqueNodes.length ) {
      logger.warnWithExtra( "camera_roll_copy_incomplete", {
        copied: results.length,
        selected: uniqueNodes.length,
        failedFileTypes: summarizeTypes( failedExtensions ),
      } );
    }
    return results;
  }, [] );

  // Runs after the user has already been sent to Group Photos, so it touches
  // no component state: every photo it copies is reported into the store,
  // which is what that screen draws from.
  const importIntoGroupPhotos = useCallback( async (
    photoNodes: PhotoNode[],
    videoNodes: PhotoNode[],
  ) => {
    const startedAt = Date.now( );
    const total = photoNodes.length + videoNodes.length;
    const fileTypes = summarizeTypes( [
      ...videoNodes.map( ( ) => "video" ),
      ...photoNodes.map( node => fileExtension( node.image.filename ) ),
    ] );
    const megabytes = totalMegabytes(
      [...photoNodes, ...videoNodes].map( node => node.image.fileSize ),
    );
    // An import the app never comes back from — see photoImportMarker.ts. The
    // marker is reported by the next launch, not here. The picker used to own
    // this, but it now hands the import off and returns, so the wait that can
    // wedge is this one.
    markPhotoImportStarted( total );
    let settled = 0;
    let failed = 0;
    let abandoned = false;
    const stallTimer = setTimeout( ( ) => {
      logger.errorWithExtra( "photo_import_stalled", {
        selected: total,
        settled,
        failed,
        ms: Date.now( ) - startedAt,
        fileTypes,
        megabytes,
      } );
    }, 30000 );

    // Read once for the whole import: the set walks every saved observation,
    // and marking each photo as it lands would otherwise walk them per photo.
    const previouslyUploadedUris = getPreviouslyUploadedDevicePhotoUrisSet( realm );
    const importedUris: string[] = [];
    const unsettled = new Set<PhotoNode>( [...photoNodes, ...videoNodes] );

    const settle = ( node: PhotoNode, resolution: GroupedPhotoResolution | null ) => {
      unsettled.delete( node );
      settled += 1;
      if ( !resolution ) { failed += 1; }
      updatePhotoImportProgress( settled, failed );
      // A placeholder that has gone means the user discarded the import, or
      // removed that cell, while its media was still being written.
      if ( !resolveGroupedPhotoPlaceholder( node.image.uri, resolution ) ) {
        abandoned = true;
      }
    };

    const copyPhotos = async ( ) => {
      if ( photoNodes.length === 0 ) return;
      await copyImagesFromCameraRoll( photoNodes, ( node, copied ) => {
        if ( !copied ) {
          settle( node, null );
          return;
        }
        const photo = markDuplicatePhotoFromLibrary(
          previouslyUploadedUris,
          copied,
          copied.sourceAsset,
        );
        importedUris.push( photo.image.uri );
        settle( node, {
          photos: [photo],
          originalDevicePhotoUris: getOriginalDevicePhotoUrisFromAssets( [copied.sourceAsset] ),
          deviceUriMappings: [{
            localUri: photo.image.uri,
            deviceUri: photo.originalDevicePhotoUri,
          }],
        } );
      } );
    };

    // Transcoding videos and copying photos go through unrelated subsystems —
    // AVFoundation against a decoder, PhotoKit against the asset store — so
    // they overlap. The videos stay one at a time between themselves: several
    // concurrent transcodes only contend for the same encoder.
    const extractVideos = async ( ) => {
      for ( const node of videoNodes ) {
        // eslint-disable-next-line no-await-in-loop
        const { gifUri, audioUri } = await extractVideoMedia( node ).catch( error => {
          logger.error( "Error extracting media from a video", error );
          return { gifUri: null, audioUri: null };
        } );
        // A video that yields neither a GIF nor audio contributed nothing to
        // the import, so its cell goes away like a photo that failed to copy.
        settle( node, ( gifUri || audioUri )
          ? {
            photos: gifUri
              ? [gifPhotoItem( node, gifUri )]
              : [],
            extraItems: audioUri
              ? [buildGroupedSoundItem( audioUri, node.timestamp )]
              : [],
          }
          : null );
      }
    };

    try {
      await Promise.all( [copyPhotos( ), extractVideos( )] );
    } catch ( error ) {
      // Nothing is still running behind whatever hasn't landed yet, so those
      // cells would sit on the grid for good and the import button would stay
      // disabled behind them. Take them out and let the user get on with the
      // photos that did make it.
      logger.error( "Error importing photos from camera roll", error );
      unsettled.forEach( node => settle( node, null ) );
    } finally {
      clearTimeout( stallTimer );
      // The import reached an end, however badly, so it is not one of the ones
      // that vanish with the process.
      clearPhotoImportMarker( );
    }

    if ( importedUris.length > 0 ) {
      trackImagesLoaded( importedUris, "photoLibrary" );
    }
    const ms = Date.now( ) - startedAt;
    if ( ms > 3000 ) {
      logger.infoWithExtra( "photo_import_slow", {
        selected: total, ms, fileTypes, megabytes,
      } );
    }

    // Every copy failing leaves the user on an empty Group Photos screen with
    // nothing to say why. Not raised when the placeholders were abandoned: the
    // empty screen is then what the user asked for by discarding the import.
    if ( total > 0 && failed === total && !abandoned ) {
      logger.errorWithExtra( "photo_import_produced_nothing", {
        selected: total,
        fileTypes,
      } );
      Alert.alert(
        t( "Something-went-wrong" ),
        t( "Could-not-import-selected-photos" ),
      );
    }
  }, [
    copyImagesFromCameraRoll,
    realm,
    resolveGroupedPhotoPlaceholder,
    t,
    trackImagesLoaded,
  ] );

  const handleGalleryDone = useCallback( async (
    nodes: PhotoNode[],
    onProgress?: ( completed: number, failed: number ) => void,
  ) => {
    try {
      // Every node for a given asset resolves to the same destination path, so
      // copying one twice in a batch has the two writes racing over the same
      // file (each unlinking what the other just wrote) and both fail with
      // "PHPhotosErrorDomain error -1", dropping the photo from the import.
      const uniqueNodes = [...new Map(
        nodes.map( node => [node.image.uri, node] ),
      ).values( )];

      if ( !skipGroupPhotos ) {
        // Group Photos opens on a grid of placeholder cells and fills each one
        // in as its own photo lands, rather than holding the picker behind a
        // progress bar until every photo has been copied — which for a large
        // selection, or one iCloud has to download, is the longest wait in the
        // import.
        //
        // Coming back here from Group Photos to add more, a photo whose copy
        // is still running is left out: it already has a cell waiting for it,
        // and copying it twice at once has both writes racing over the same
        // destination file, which fails them both.
        const pendingUris = new Set<string>( groupedPhotos.flatMap(
          ( group: GroupedPhoto ) => ( group.photos || [] )
            .filter( photo => photo.pending )
            .map( photo => photo.image.uri ),
        ) );
        const newNodes = uniqueNodes.filter( node => !pendingUris.has( node.image.uri ) );
        const placeholders = newNodes.map( placeholderGroup );
        setGroupedPhotos( sortGroupsByTime( fromGroupPhotos
          ? [...groupedPhotos, ...placeholders]
          : placeholders ) );
        navigation.setParams( { fromGroupPhotos: false } );
        navigation.navigate( "GroupPhotos" );
        // Straight on into the cropper for the batch just picked, with Group
        // Photos left underneath it: it crops each photo as the import lands
        // it and drops the user on the grid after the last one. Coming back
        // here to add more only crops the photos being added, so the ones
        // already in the grid are skipped.
        navigation.navigate( "ImageCropEditor", {
          context: "groupPhotos",
          cropImport: true,
          skipUris: fromGroupPhotos
            ? groupedPhotos.flatMap( ( group: GroupedPhoto ) => ( group.photos || [] )
              .filter( photo => !photo.pending )
              .map( photo => photo.image.uri ) )
            : [],
        } );
        importIntoGroupPhotos(
          newNodes.filter( node => !isVideoNode( node ) ),
          newNodes.filter( isVideoNode ),
        );
        return { continuesInBackground: true };
      }

      // Adding evidence to an observation already open in ObsEdit: there is no
      // grid to fill in, so the picker keeps its progress bar until the photos
      // have been copied. Videos aren't extracted, since a GIF or an audio
      // track has nowhere to go here — the same as before, when they were
      // extracted and then dropped.
      const photoNodes = uniqueNodes.filter( node => !isVideoNode( node ) );
      let settled = 0;
      let failed = 0;
      const copiedPhotos = await copyImagesFromCameraRoll( photoNodes, ( _node, copied ) => {
        settled += 1;
        if ( !copied ) { failed += 1; }
        onProgress?.( settled, failed );
      } );

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

      // Every copy failing leaves nothing to hand on, and returning to ObsEdit
      // anyway is indistinguishable from the check doing nothing at all. Say
      // what happened and stay put so the selection survives a retry.
      if ( photoNodes.length > 0 && selectedPhotos.length === 0 ) {
        logger.errorWithExtra( "photo_import_produced_nothing", {
          selected: photoNodes.length,
          fileTypes: summarizeTypes(
            photoNodes.map( node => fileExtension( node.image.filename ) ),
          ),
        } );
        Alert.alert(
          t( "Something-went-wrong" ),
          t( "Could-not-import-selected-photos" ),
        );
        return { continuesInBackground: false };
      }

      const importedPhotoUris = selectedPhotos.map( x => x.image.uri );
      if ( importedPhotoUris.length > 0 ) {
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
      navToObsEdit( );
      return { continuesInBackground: false };
    } catch ( error ) {
      logger.error( "Error importing photos from camera roll", error );
      // Dropping the user out of the flow with no explanation is
      // indistinguishable from the import having been cancelled — and when the
      // cause is unreadable metadata, from an import that quietly lost the
      // photo's date and location.
      Alert.alert(
        t( "Something-went-wrong" ),
        t( "Could-not-import-your-photos-nothing-was-saved" ),
      );
      exitObservationFlow( );
      return { continuesInBackground: false };
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
    importIntoGroupPhotos,
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
        maxPhotos={( fromAICamera && isDefaultMode )
          ? FROM_AICAMERA_MAX_PHOTOS_ALLOWED
          : MAX_PHOTOS_ALLOWED}
        onCancel={handleSelectionCancelled}
        onDone={handleGalleryDone}
      />
    </ViewWrapper>
  );
};

export default PhotoLibrary;
