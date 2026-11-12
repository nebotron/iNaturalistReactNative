import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import {
  CameraRoll,
  iosRequestReadWriteGalleryPermission,
} from "@react-native-camera-roll/camera-roll";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import DevicePhotoGrid from "components/PhotoImporter/DevicePhotoGrid";
import type { PhotoGalleryListItem } from "components/PhotoImporter/helpers/photoGallerySections";
import buildSectionedGalleryItems from "components/PhotoImporter/helpers/photoGallerySections";
import { isVideoNode } from "components/PhotoImporter/helpers/videoImportHelpers";
import PhotoGalleryImage from "components/PhotoImporter/PhotoGalleryImage";
import { Body2 } from "components/SharedComponents";
import INatIconButton from "components/SharedComponents/Buttons/INatIconButton";
import ImportProgressBanner from "components/SharedComponents/ImportProgressBanner";
import { View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Platform,
} from "react-native";
import type Realm from "realm";
import type { RealmObservation } from "realmModels/types";
import { formatDateStringFromTimestamp } from "sharedHelpers/dateAndTime";
import {
  getDevicePhotoUrisFromObservation,
  getPreviouslyUploadedDevicePhotoUrisSet,
  recordUploadedDevicePhotoUris,
} from "sharedHelpers/duplicateUploadedDevicePhotos";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import { noteCropRequested } from "sharedHelpers/imageCropPreload";
import {
  fileExtension,
  summarizeTypes,
  totalMegabytes,
} from "sharedHelpers/importedFileTypes";
import { log } from "sharedHelpers/logger";
import {
  clearPhotoImportMarker,
  markPhotoImportStarted,
  updatePhotoImportProgress,
} from "sharedHelpers/photoImportMarker";
import {
  canPreloadPickerPhoto,
  PICKER_PRELOAD_COUNT,
  preloadPickerPhoto,
  releasePickerPreloads,
} from "sharedHelpers/pickerCropPreload";
import {
  addRemovedGroupPhotoUris,
  getRemovedGroupPhotoUris,
} from "sharedHelpers/removedGroupPhotoUris";
import { devicePhotoKey, listStagedPhotoNodes } from "sharedHelpers/usbStaging";
import { useGridLayout, useTranslation } from "sharedHooks";
import useUsbImportProgress from "stores/usbImportProgress";
import colors from "styles/tailwindColors";

type PhotoNode = PhotoIdentifier["node"];

interface Props {
  maxPhotos: number;
  onCancel: () => void;
  // onProgress reports how many of the selected items have finished importing
  // and how many of those failed, so the overlay can show real progress
  // instead of an open-ended spinner. An import that only hands the work off —
  // Group Photos copies its photos in the background, filling its grid in as
  // they land — says so, and owns the progress reporting from there.
  onDone: (
    selectedNodes: PhotoNode[],
    onProgress?: ( completed: number, failed: number ) => void
  ) => Promise<{ continuesInBackground?: boolean } | void>;
}

const { useRealm } = RealmContext;

const logger = log.extend( "PhotoGallery" );

const PAGE_SIZE = 60;

type GalleryInclude = NonNullable<Parameters<typeof CameraRoll.getPhotos>[0]["include"]>;

const GALLERY_INCLUDE: GalleryInclude = Platform.OS === "android"
  ? ["filename", "fileSize", "filepath", "imageSize", "location"]
  : ["filename", "fileSize", "imageSize", "location"];

const getDeviceUriFromNode = ( node: PhotoNode ): string | null => {
  // A staged SD card photo (see usbStaging.ts), not a library asset
  if ( Platform.OS === "ios" && !node.image.uri.startsWith( "file://" ) ) {
    if ( !node.id ) {
      return null;
    }
    return normalizeDevicePhotoUri( `ph://${node.id}` );
  }
  return normalizeDevicePhotoUri( node.image.uri );
};

const getSelectionKey = ( node: PhotoNode ) => node.image.uri;

const readRemovedGroupPhotoUris = ( ) => new Set(
  getRemovedGroupPhotoUris( ).map( devicePhotoKey ),
);

const PhotoGallery = ( {
  maxPhotos,
  onCancel,
  onDone,
}: Props ) => {
  const { t } = useTranslation( );
  const realm = useRealm( );
  const {
    gridItemStyle,
    gridItemWidth,
    numColumns,
  } = useGridLayout( undefined, "threeUp" );

  const [libraryPhotos, setPhotos] = useState<PhotoNode[]>( [] );
  // Staged SD card photos, which live in the app rather than in Photos
  const [stagedPhotos, setStagedPhotos] = useState<PhotoNode[]>( [] );
  // Re-listed as a USB import copies each file, so groups appear as they fill
  const usbImportActive = useUsbImportProgress( state => state.active );
  const usbImportSaved = useUsbImportProgress( state => state.saved );
  useEffect( ( ) => {
    listStagedPhotoNodes( ).then( setStagedPhotos ).catch( error => {
      logger.error( "Could not list staged SD card photos", error );
    } );
  }, [usbImportActive, usbImportSaved] );
  // The import copies newest first, so the group holding the file it copied
  // last is still filling. Staged names start with the time they were copied.
  const usbImportingKey = useMemo( ( ) => {
    if ( !usbImportActive || stagedPhotos.length === 0 ) return null;
    const copiedAt = ( node: PhotoNode ) => parseInt( node.image.filename ?? "", 10 ) || 0;
    const latest = stagedPhotos.reduce( ( a, b ) => ( copiedAt( b ) > copiedAt( a )
      ? b
      : a ) );
    return getSelectionKey( latest );
  }, [usbImportActive, stagedPhotos] );
  const [hasNextPage, setHasNextPage] = useState( true );
  const [loading, setLoading] = useState( true );
  // Merged newest first, which the sections assume. A staged photo older than
  // the last page loaded waits for that page, so it lands in the right place.
  const photos = useMemo( ( ) => {
    if ( stagedPhotos.length === 0 ) return libraryPhotos;
    const oldestLoaded = libraryPhotos[libraryPhotos.length - 1]?.timestamp ?? Infinity;
    const staged = stagedPhotos.filter( node => !hasNextPage || node.timestamp >= oldestLoaded );
    return [...libraryPhotos, ...staged].sort( ( a, b ) => b.timestamp - a.timestamp );
  }, [libraryPhotos, stagedPhotos, hasNextPage] );
  const [endCursor, setEndCursor] = useState<string | undefined>( undefined );
  const [selectedUris, setSelectedUris] = useState<Set<string>>( new Set( ) );
  const [importedUris, setImportedUris] = useState<Set<string>>( new Set( ) );
  const [hideImported, setHideImported] = useState( true );
  // Photos queued for deletion from this screen; hidden unless showing all photos.
  const [deletedUris, setDeletedUris] = useState<Set<string>>( new Set( ) );
  const [importingCount, setImportingCount] = useState( 0 );
  const [importedCount, setImportedCount] = useState( 0 );
  const [failedCount, setFailedCount] = useState( 0 );
  const isFetchingRef = useRef( false );
  const importingRef = useRef( false );
  // How long the picker took to show its first photo, and how many pages it
  // had to read to get there (see the slow-open report below).
  const openedAtRef = useRef( 0 );
  const pagesFetchedRef = useRef( 0 );
  const reportedOpenRef = useRef( false );
  // Photos the user removed from a Group Photos import previously (see
  // removedGroupPhotoUris.ts) — the device deletion may have silently failed
  // (iOS 26's PHPhotoLibrary confirmation bug), so they count as saved and are
  // hidden along with them unless the user taps Show all photos. Re-read on
  // focus, since Group Photos is opened on top of this screen.
  const [removedGroupPhotoUris, setRemovedGroupPhotoUris] = useState( readRemovedGroupPhotoUris );
  useFocusEffect( useCallback( ( ) => {
    setRemovedGroupPhotoUris( readRemovedGroupPhotoUris( ) );
  }, [] ) );

  // Kept up to date while the screen is open rather than read once on mount:
  // an import saves its observations in the background after the user is
  // already back on My Observations (see GroupPhotosContainer), and an upload
  // indexes its photos later still, so photos can become "saved" with this
  // screen sitting open in the tab stack. Additions are folded in one change
  // at a time, since recomputing the whole set means walking every saved
  // observation.
  useEffect( ( ) => {
    setImportedUris( new Set(
      [...getPreviouslyUploadedDevicePhotoUrisSet( realm )].map( devicePhotoKey ),
    ) );

    const addUris = ( uris: ( string | null )[] ) => {
      const newUris = uris.filter( ( uri ): uri is string => !!uri ).map( devicePhotoKey );
      if ( newUris.length === 0 ) return;
      setImportedUris( prev => {
        if ( newUris.every( uri => prev.has( uri ) ) ) return prev;
        return new Set( [...prev, ...newUris] );
      } );
    };

    const uploadedRecords = realm.objects( "UploadedDevicePhotoUri" );
    const observations = realm.objects<RealmObservation>( "Observation" );
    const uploadedListener: Realm.CollectionChangeCallback<
      Realm.Object
    > = ( collection, changes ) => {
      addUris( [...changes.insertions, ...changes.newModifications].map(
        index => normalizeDevicePhotoUri(
          ( collection[index] as unknown as { uri?: string } )?.uri,
        ),
      ) );
    };
    const observationListener: Realm.CollectionChangeCallback<
      RealmObservation
    > = ( collection, changes ) => {
      addUris( [...changes.insertions, ...changes.newModifications].flatMap(
        index => ( collection[index]
          ? getDevicePhotoUrisFromObservation( collection[index] )
          : [] ),
      ) );
    };
    uploadedRecords.addListener( uploadedListener );
    observations.addListener( observationListener );
    return ( ) => {
      uploadedRecords.removeListener( uploadedListener );
      observations.removeListener( observationListener );
    };
  }, [realm] );

  const loadPhotos = useCallback( async ( after?: string ) => {
    if ( isFetchingRef.current ) {
      return;
    }
    isFetchingRef.current = true;
    try {
      const result = await CameraRoll.getPhotos( {
        first: PAGE_SIZE,
        assetType: "All",
        after,
        // "location" is PHAsset.location, which is where a location set by
        // hand in the Photos app lives — the photo file itself is never
        // rewritten, so that location is not in the EXIF we import.
        // Each included field is resolved per asset, so asking for one that is
        // never read costs a page of the grid for nothing: "filepath" is only
        // ever consulted on Android, where it is what bypasses MediaStore's
        // GPS-stripping (see PhotoLibrary and videoImportHelpers).
        include: GALLERY_INCLUDE,
      } );
      const nodes = result.edges.map( e => e.node );
      setPhotos( prev => {
        if ( !after ) return nodes;
        // CameraRoll's cursor-based pages overlap when the library changes
        // mid-pagination — which it does constantly here, since importing
        // deletes device photos and rewrites asset locations. A duplicated
        // node meant two concurrent copies racing to write the same
        // destination file on import, and both failing with the opaque
        // "PHPhotosErrorDomain error -1".
        const seen = new Set( prev.map( getSelectionKey ) );
        return [
          ...prev,
          ...nodes.filter( node => !seen.has( getSelectionKey( node ) ) ),
        ];
      } );
      setHasNextPage( result.page_info.has_next_page );
      setEndCursor( result.page_info.end_cursor );
      pagesFetchedRef.current += 1;
    } catch ( error ) {
      // Nothing changes after a failed page, so nothing would ever ask for
      // the next one: with more pages assumed, the auto-fill below would leave
      // the grid empty (or the newest-first sections withheld) for good. Treat
      // the library as ending here so what did load is shown.
      logger.error( "Could not load photos from the device library", error );
      setHasNextPage( false );
    } finally {
      isFetchingRef.current = false;
      setLoading( false );
    }
  }, [] );

  // Read through a ref so the permission request and first page run once per
  // mount. onCancel changes whenever the screen's params do (PhotoLibrary sets
  // them on every Done, and re-navigating here passes new ones), and each
  // change re-requested permission and replaced every loaded page with the
  // first one -- restarting a long auto-fill from scratch.
  const onCancelRef = useRef( onCancel );
  useEffect( ( ) => {
    onCancelRef.current = onCancel;
  }, [onCancel] );

  useEffect( ( ) => {
    openedAtRef.current = Date.now( );
    if ( Platform.OS === "ios" ) {
      iosRequestReadWriteGalleryPermission( ).then( status => {
        if ( status === "granted" || status === "limited" ) {
          loadPhotos( );
        } else {
          // The screen closes itself here, which to the user is the picker
          // failing to open, so leave a trace of why.
          logger.info( `photo_gallery_permission_not_granted: ${status}` );
          onCancelRef.current( );
        }
      } ).catch( error => {
        logger.error( "Could not request photo library permission", error );
        loadPhotos( );
      } );
    } else {
      loadPhotos( );
    }
  }, [loadPhotos] );

  const loadMore = useCallback( ( ) => {
    if ( hasNextPage && !isFetchingRef.current ) {
      loadPhotos( endCursor );
    }
  }, [hasNextPage, endCursor, loadPhotos] );

  const toggleSelection = useCallback( ( node: PhotoNode ) => {
    const key = getSelectionKey( node );
    setSelectedUris( prev => {
      const next = new Set( prev );
      if ( next.has( key ) ) {
        next.delete( key );
      } else if ( next.size < maxPhotos ) {
        next.add( key );
      }
      return next;
    } );
  }, [maxPhotos] );

  // Importing can take tens of seconds (an iCloud-offloaded asset retries the
  // download with backoff) and this screen stays up the whole time, so without
  // a guard every extra tap starts another import of the same assets. Those
  // concurrent imports then race on the same destination file, which fails
  // *every* copy with the opaque "PHPhotosErrorDomain error -1" — so nothing
  // imports at all and the check looks dead rather than merely slow.
  const handleDone = useCallback( async ( ) => {
    if ( importingRef.current ) {
      logger.info( "Done tapped while an import was already running; ignoring" );
      return;
    }
    const selected = photos.filter( node => selectedUris.has( getSelectionKey( node ) ) );
    noteCropRequested( );
    // The selected photos' prepares carry over to their imported copies; the
    // rest leave the preload queue now, so they can't delay the first photo.
    releasePickerPreloads( new Set( selected.map( node => node.image.uri ) ) );
    importingRef.current = true;
    setImportingCount( selected.length );
    setImportedCount( 0 );
    setFailedCount( 0 );
    const startedAt = Date.now( );
    // What the import was actually handed. A stalled or slow import says
    // nothing about *which* files it was chewing on otherwise, and "all five
    // were HEIC" or "one was a 90MB video" is the first thing worth knowing.
    const fileTypes = summarizeTypes( selected.map( node => ( isVideoNode( node )
      ? "video"
      : fileExtension( node.image.filename ) ) ) );
    const megabytes = totalMegabytes( selected.map( node => node.image.fileSize ) );
    // An import the app never comes back from — see photoImportMarker.ts. The
    // marker is reported by the next launch, not here.
    markPhotoImportStarted( selected.length );
    // Three imports in the app log logged the tap above and no "settled" line
    // at all before the app was relaunched — the import wedged on one asset and
    // the log could only say that, not where or how far in. Report the progress
    // counts once the import is far past the ~300ms a local batch takes, so a
    // wedge is distinguishable from a slow iCloud download that is still
    // advancing. One line per stuck import, none on the happy path.
    let settledCount = 0;
    let failedSoFar = 0;
    let continuesInBackground = false;
    const stallTimer = setTimeout( ( ) => {
      logger.errorWithExtra( "photo_import_stalled", {
        selected: selected.length,
        settled: settledCount,
        failed: failedSoFar,
        ms: Date.now( ) - startedAt,
        fileTypes,
        megabytes,
      } );
    }, 30000 );
    try {
      const result = await onDone( selected, ( completed, failed ) => {
        settledCount = completed;
        failedSoFar = failed;
        updatePhotoImportProgress( completed, failed );
        setImportedCount( completed );
        setFailedCount( failed );
      } );
      continuesInBackground = !!result?.continuesInBackground;
      // Only a slow import that did finish is logged: a local batch settles in
      // ~150ms, photo_import_stalled below covers a wedge, and an import the
      // process never returns from is reported by the next launch's marker.
      const ms = Date.now( ) - startedAt;
      if ( ms > 3000 && !continuesInBackground ) {
        logger.infoWithExtra( "photo_import_slow", {
          selected: selected.length,
          ms,
          fileTypes,
          megabytes,
        } );
      }
    } finally {
      // The import reached an end, however badly, so it is not one of the ones
      // that vanish with the process. An import still running in the
      // background owns its own marker and stall reporting.
      if ( !continuesInBackground ) {
        clearPhotoImportMarker( );
      }
      clearTimeout( stallTimer );
      importingRef.current = false;
      setImportingCount( 0 );
    }
  }, [photos, selectedUris, onDone] );

  // Record the selected photos as already saved without importing them, so the
  // hide saved photos button hides them from now on. Useful for photos the user has
  // already uploaded some other way, or never wants offered for import again.
  const markSelectedAsSaved = useCallback( ( ) => {
    const deviceUris = photos
      .filter( node => selectedUris.has( getSelectionKey( node ) ) )
      .map( getDeviceUriFromNode )
      .filter( ( uri ): uri is string => !!uri );
    recordUploadedDevicePhotoUris( realm, deviceUris );
    setImportedUris( prev => new Set( [...prev, ...deviceUris.map( devicePhotoKey )] ) );
    setSelectedUris( new Set( ) );
  }, [photos, realm, selectedUris] );

  // Queue the selected photos for the imported album (see
  // removedGroupPhotoUris.ts) and hide them from the picker.
  const deleteSelected = useCallback( ( ) => {
    const deviceUris = photos
      .filter( node => selectedUris.has( getSelectionKey( node ) ) )
      .map( getDeviceUriFromNode )
      .filter( ( uri ): uri is string => !!uri );
    addRemovedGroupPhotoUris( deviceUris );
    setDeletedUris( prev => new Set( [...prev, ...deviceUris.map( devicePhotoKey )] ) );
    setSelectedUris( new Set( ) );
  }, [photos, selectedUris] );

  const isImported = useCallback( ( node: PhotoNode ): boolean => {
    const uri = getDeviceUriFromNode( node );
    if ( !uri ) {
      return false;
    }
    const key = devicePhotoKey( uri );
    return importedUris.has( key ) || removedGroupPhotoUris.has( key );
  }, [importedUris, removedGroupPhotoUris] );

  const hasHiddenPhotos = importedUris.size > 0
    || deletedUris.size > 0
    || removedGroupPhotoUris.size > 0;

  const visiblePhotos = useMemo(
    ( ) => photos.filter( node => {
      if ( !hideImported ) return true;
      const uri = getDeviceUriFromNode( node );
      return !( uri && deletedUris.has( devicePhotoKey( uri ) ) ) && !isImported( node );
    } ),
    [photos, hideImported, isImported, deletedUris],
  );

  // Prepare the newest photos for cropping before any are selected, and the
  // newest selected one, which is the photo the cropper opens on after Done
  // (see pickerCropPreload). Only while this screen is in front: after Done
  // it sits under Group Photos and the cropper, whose photos come first.
  const isFocused = useIsFocused( );
  useEffect( ( ) => {
    if ( !isFocused || importingRef.current ) return;
    const preloadable = visiblePhotos.filter( node => !isVideoNode( node )
      && !( node.image.filename ?? "" ).toLowerCase( ).endsWith( ".gif" )
      && canPreloadPickerPhoto( node.image.uri ) );
    const newestSelected = preloadable.find(
      node => selectedUris.has( getSelectionKey( node ) ),
    );
    [
      ...( newestSelected
        ? [newestSelected]
        : [] ),
      ...preloadable.slice( 0, PICKER_PRELOAD_COUNT ),
    ].forEach( node => preloadPickerPhoto( node.image.uri, node.image.filename ) );
  }, [isFocused, visiblePhotos, selectedUris] );
  // Leaving without importing drops what was prepared (Done hands the
  // selected photos' prepares to the import before this runs).
  useFocusEffect( useCallback( ( ) => ( ) => releasePickerPreloads( ), [] ) );

  const galleryItems = useMemo( ( ) => {
    const items = buildSectionedGalleryItems( visiblePhotos, getSelectionKey, hasNextPage );
    if ( !usbImportingKey ) return items;
    const partial = items.find( item => item.type === "header"
      && item.nodes.some( node => getSelectionKey( node ) === usbImportingKey ) );
    if ( partial?.type !== "header" ) return items;
    const hidden = new Set( partial.nodes.map( getSelectionKey ) );
    return items.filter( item => item !== partial
      && !( item.type === "photo" && hidden.has( item.id ) ) );
  }, [visiblePhotos, hasNextPage, usbImportingKey] );

  // The last section is withheld while more pages remain, since it may
  // still grow or split further. If that leaves nothing to show, the list
  // is empty and onEndReached never fires, so keep fetching automatically
  // until a finalized section appears or there are no more photos.
  useEffect( ( ) => {
    if ( !loading && hasNextPage && photos.length > 0 && galleryItems.length === 0 ) {
      loadMore( );
    }
  }, [loading, hasNextPage, photos.length, galleryItems.length, loadMore] );
  // Pages of nothing but saved (hidden) photos are fetched one after another
  // before anything can be shown, and every page after the first makes iOS
  // walk the library from the top to find its cursor. For someone who saves
  // most of what they shoot that is a long wait on an empty grid, so show it
  // as loading rather than as a picker that never opened.
  const fillingFirstScreen = hasNextPage && galleryItems.length === 0;

  useEffect( ( ) => {
    if ( reportedOpenRef.current || loading || fillingFirstScreen ) return;
    reportedOpenRef.current = true;
    const ms = Date.now( ) - openedAtRef.current;
    if ( ms > 2000 ) {
      logger.infoWithExtra( "photo_gallery_slow_open", {
        ms,
        pages: pagesFetchedRef.current,
        loaded: photos.length,
        hidden: photos.length - visiblePhotos.length,
      } );
    }
  }, [
    loading,
    fillingFirstScreen,
    photos.length,
    visiblePhotos.length,
  ] );

  const toggleSectionSelection = useCallback( ( nodes: PhotoNode[] ) => {
    setSelectedUris( prev => {
      const next = new Set( prev );
      const allSelected = nodes.every( node => next.has( getSelectionKey( node ) ) );
      if ( allSelected ) {
        nodes.forEach( node => next.delete( getSelectionKey( node ) ) );
      } else {
        for ( let i = 0; i < nodes.length; i += 1 ) {
          if ( next.size >= maxPhotos ) {
            break;
          }
          next.add( getSelectionKey( nodes[i] ) );
        }
      }
      return next;
    } );
  }, [maxPhotos] );

  const renderHeader = useCallback( ( item: PhotoGalleryListItem ) => {
    if ( item.type !== "header" ) return null;
    const allSelected = item.nodes.length > 0
      && item.nodes.every( node => selectedUris.has( getSelectionKey( node ) ) );
    return (
      <View className="px-3 py-1 flex-row items-center justify-between">
        <Body2>
          {`${
            formatDateStringFromTimestamp( item.timestamp ).replace( "T", " " )
          } (${item.nodes.length})`}
        </Body2>
        <INatIconButton
          icon="checkmark"
          onPress={( ) => toggleSectionSelection( item.nodes )}
          accessibilityLabel={allSelected
            ? t( "Deselect-all-photos" )
            : t( "Select-all-photos" )}
          size={18}
          color={allSelected
            ? colors.inatGreen
            : colors.darkGray}
          testID={`PhotoGallery.section.${item.id}`}
        />
      </View>
    );
  }, [selectedUris, toggleSectionSelection, t] );

  const renderPhoto = useCallback( ( item: PhotoGalleryListItem ) => {
    if ( item.type !== "photo" ) return null;
    const { node } = item;
    const key = getSelectionKey( node );
    return (
      <PhotoGalleryImage
        node={node}
        selectionKey={key}
        selected={selectedUris.has( key )}
        imported={isImported( node )}
        isVideo={isVideoNode( node )}
        cellWidth={gridItemWidth}
        gridItemStyle={gridItemStyle}
        onPress={toggleSelection}
      />
    );
  }, [
    selectedUris,
    isImported,
    toggleSelection,
    gridItemStyle,
    gridItemWidth,
  ] );

  const getPhotoUri = useCallback( ( item: PhotoGalleryListItem ) => ( item.type === "photo"
    ? item.node.image.uri
    : undefined ), [] );

  if ( loading ) {
    return (
      <View className="flex-1 justify-center items-center">
        <ActivityIndicator />
      </View>
    );
  }

  const selectedCount = selectedUris.size;
  const importing = importingCount > 0;

  return (
    <View className="flex-1">
      <View
        className="flex-row items-center px-2 py-1 gap-1"
      >
        <INatIconButton
          icon="close"
          onPress={onCancel}
          accessibilityLabel={t( "Cancel" )}
          size={22}
          color={colors.darkGray}
        />
        {hasHiddenPhotos && (
          <INatIconButton
            icon={hideImported
              ? "eye-off"
              : "eye"}
            onPress={( ) => setHideImported( prev => !prev )}
            accessibilityLabel={hideImported
              ? t( "Show-all-photos" )
              : t( "Hide-saved-photos" )}
            size={22}
            color={hideImported
              ? colors.darkGray
              : colors.inatGreen}
            testID="PhotoGallery.hideImported"
          />
        )}
        <View className="flex-1" />
        <INatIconButton
          icon="trash-outline"
          onPress={deleteSelected}
          accessibilityLabel={t( "Delete-selected-photos" )}
          disabled={selectedCount === 0 || importing}
          size={22}
          color={colors.darkGray}
          testID="PhotoGallery.delete"
        />
        <INatIconButton
          icon="checkmark-circle"
          onPress={markSelectedAsSaved}
          accessibilityLabel={t( "Mark-photos-as-already-saved" )}
          disabled={selectedCount === 0 || importing}
          size={22}
          color={colors.darkGray}
          testID="PhotoGallery.markAsSaved"
        />
        <INatIconButton
          icon="checkmark"
          onPress={handleDone}
          accessibilityLabel={t( "DONE" )}
          disabled={selectedCount === 0 || importing}
          size={22}
          color={colors.inatGreen}
          testID="PhotoGallery.done"
        />
      </View>
      <DevicePhotoGrid
        items={galleryItems}
        numColumns={numColumns}
        itemWidth={gridItemWidth}
        renderHeader={renderHeader}
        renderPhoto={renderPhoto}
        getPhotoUri={getPhotoUri}
        onEndReached={loadMore}
        extraData={{ selectedUris, importedUris }}
      />
      {fillingFirstScreen && (
        <View
          className="absolute inset-0 justify-center items-center"
          pointerEvents="none"
          testID="PhotoGallery.fillingIndicator"
        >
          <ActivityIndicator />
        </View>
      )}
      {/* Swapping the small header check for an equally small spinner was too
          easy to miss on an import that runs for tens of seconds, which is the
          whole window in which the screen looks dead. Cover the grid instead,
          so the wait is unmistakable and taps can't land on the photos
          underneath. */}
      {importing && (
        <View
          className="absolute inset-0 justify-center items-center px-6 bg-black/60"
          testID="PhotoGallery.importingOverlay"
        >
          <ImportProgressBanner
            title={t( "Importing-X-photos", { count: importingCount } )}
            detail={t( "X-of-Y", { x: importedCount, y: importingCount } )}
            warning={failedCount > 0
              ? t( "x-failed", { count: failedCount } )
              : undefined}
            completed={importedCount}
            total={importingCount}
          />
        </View>
      )}
    </View>
  );
};

export default PhotoGallery;
