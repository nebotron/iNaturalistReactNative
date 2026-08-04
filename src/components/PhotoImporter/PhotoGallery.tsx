import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import {
  CameraRoll,
  iosRequestReadWriteGalleryPermission,
} from "@react-native-camera-roll/camera-roll";
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
  Text,
} from "react-native";
import { Switch } from "react-native-paper";
import { formatDateStringFromTimestamp } from "sharedHelpers/dateAndTime";
import {
  getPreviouslyUploadedDevicePhotoUrisSet,
  recordUploadedDevicePhotoUris,
} from "sharedHelpers/duplicateUploadedDevicePhotos";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import { log } from "sharedHelpers/logger";
import { getRemovedGroupPhotoUris } from "sharedHelpers/removedGroupPhotoUris";
import { useGridLayout, useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

type PhotoNode = PhotoIdentifier["node"];

interface Props {
  maxPhotos: number;
  onCancel: () => void;
  // onProgress reports how many of the selected items have finished importing
  // and how many of those failed, so the overlay can show real progress
  // instead of an open-ended spinner.
  onDone: (
    selectedNodes: PhotoNode[],
    onProgress?: ( completed: number, failed: number ) => void
  ) => void | Promise<void>;
}

const { useRealm } = RealmContext;

const logger = log.extend( "PhotoGallery" );

const PAGE_SIZE = 60;

const getDeviceUriFromNode = ( node: PhotoNode ): string | null => {
  if ( Platform.OS === "ios" ) {
    if ( !node.id ) {
      return null;
    }
    return normalizeDevicePhotoUri( `ph://${node.id}` );
  }
  return normalizeDevicePhotoUri( node.image.uri );
};

const getSelectionKey = ( node: PhotoNode ) => node.image.uri;

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

  const [photos, setPhotos] = useState<PhotoNode[]>( [] );
  const [hasNextPage, setHasNextPage] = useState( true );
  const [loading, setLoading] = useState( true );
  const [endCursor, setEndCursor] = useState<string | undefined>( undefined );
  const [selectedUris, setSelectedUris] = useState<Set<string>>( new Set( ) );
  const [importedUris, setImportedUris] = useState<Set<string>>( new Set( ) );
  const [hideImported, setHideImported] = useState( true );
  const [importingCount, setImportingCount] = useState( 0 );
  const [importedCount, setImportedCount] = useState( 0 );
  const [failedCount, setFailedCount] = useState( 0 );
  const isFetchingRef = useRef( false );
  const importingRef = useRef( false );
  // Photos the user removed from a Group Photos import previously (see
  // removedGroupPhotoUris.ts) — always hidden, unlike hideImported which the
  // user can toggle, since the underlying device deletion may have silently
  // failed (iOS 26's PHPhotoLibrary confirmation bug) and re-showing them
  // would just invite re-importing something the user already said to remove.
  const removedGroupPhotoUrisRef = useRef<Set<string>>( new Set( getRemovedGroupPhotoUris( ) ) );

  useEffect( ( ) => {
    setImportedUris( getPreviouslyUploadedDevicePhotoUrisSet( realm ) );
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
        include: ["filename", "fileSize", "filepath", "imageSize"],
      } );
      const removedUris = removedGroupPhotoUrisRef.current;
      const nodes = result.edges.map( e => e.node ).filter( node => {
        const uri = getDeviceUriFromNode( node );
        return !uri || !removedUris.has( uri );
      } );
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
    } catch {
      // permissions denied or no photos available
    } finally {
      isFetchingRef.current = false;
      setLoading( false );
    }
  }, [] );

  useEffect( ( ) => {
    if ( Platform.OS === "ios" ) {
      iosRequestReadWriteGalleryPermission( ).then( status => {
        if ( status === "granted" || status === "limited" ) {
          loadPhotos( );
        } else {
          onCancel( );
        }
      } ).catch( ( ) => loadPhotos( ) );
    } else {
      loadPhotos( );
    }
  }, [loadPhotos, onCancel] );

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
    importingRef.current = true;
    setImportingCount( selected.length );
    setImportedCount( 0 );
    setFailedCount( 0 );
    // Nothing else logs the tap itself, so a slow import was indistinguishable
    // in the logs from a tap that never registered — the gap before the first
    // copy error was all we had to go on. Bracket the import so the next
    // report can be answered from the logs alone.
    logger.info( `Done tapped: importing ${selected.length} selected photo(s)` );
    const startedAt = Date.now( );
    // Three imports in the app log logged the tap above and no "settled" line
    // at all before the app was relaunched — the import wedged on one asset and
    // the log could only say that, not where or how far in. Report the progress
    // counts once the import is far past the ~300ms a local batch takes, so a
    // wedge is distinguishable from a slow iCloud download that is still
    // advancing. One line per stuck import, none on the happy path.
    let settledCount = 0;
    let failedSoFar = 0;
    const stallTimer = setTimeout( ( ) => {
      logger.errorWithExtra( "photo_import_stalled", {
        selected: selected.length,
        settled: settledCount,
        failed: failedSoFar,
        ms: Date.now( ) - startedAt,
      } );
    }, 30000 );
    try {
      await onDone( selected, ( completed, failed ) => {
        settledCount = completed;
        failedSoFar = failed;
        setImportedCount( completed );
        setFailedCount( failed );
      } );
      logger.info(
        `Import of ${selected.length} photo(s) settled in ${Date.now( ) - startedAt}ms`,
      );
    } finally {
      clearTimeout( stallTimer );
      importingRef.current = false;
      setImportingCount( 0 );
    }
  }, [photos, selectedUris, onDone] );

  // Record the selected photos as already saved without importing them, so the
  // "Hide Saved" toggle hides them from now on. Useful for photos the user has
  // already uploaded some other way, or never wants offered for import again.
  const markSelectedAsSaved = useCallback( ( ) => {
    const deviceUris = photos
      .filter( node => selectedUris.has( getSelectionKey( node ) ) )
      .map( getDeviceUriFromNode )
      .filter( ( uri ): uri is string => !!uri );
    recordUploadedDevicePhotoUris( realm, deviceUris );
    setImportedUris( prev => new Set( [...prev, ...deviceUris] ) );
    setSelectedUris( new Set( ) );
  }, [photos, realm, selectedUris] );

  const isImported = useCallback( ( node: PhotoNode ): boolean => {
    const uri = getDeviceUriFromNode( node );
    if ( !uri ) {
      return false;
    }
    return importedUris.has( uri );
  }, [importedUris] );

  const hasImportedPhotos = importedUris.size > 0;

  // Photos newer than the most recently imported one, i.e. everything
  // that's shown up since the last time photos were imported from here.
  const photosSinceLastImport = useMemo( ( ) => {
    if ( !hasImportedPhotos ) {
      return [];
    }
    const lastImportedIndex = photos.findIndex( isImported );
    if ( lastImportedIndex === -1 ) {
      return photos;
    }
    return photos.slice( 0, lastImportedIndex );
  }, [photos, isImported, hasImportedPhotos] );

  const selectSinceLastImport = useCallback( ( ) => {
    setSelectedUris( prev => {
      const next = new Set( prev );
      for ( let i = 0; i < photosSinceLastImport.length; i += 1 ) {
        if ( next.size >= maxPhotos ) {
          break;
        }
        next.add( getSelectionKey( photosSinceLastImport[i] ) );
      }
      return next;
    } );
  }, [photosSinceLastImport, maxPhotos] );

  const visiblePhotos = useMemo(
    ( ) => ( hideImported
      ? photos.filter( node => !isImported( node ) )
      : photos ),
    [photos, hideImported, isImported],
  );

  const galleryItems = useMemo(
    ( ) => buildSectionedGalleryItems( visiblePhotos, getSelectionKey, hasNextPage ),
    [visiblePhotos, hasNextPage],
  );

  // The last section is withheld while more pages remain, since it may
  // still grow or split further. If that leaves nothing to show, the list
  // is empty and onEndReached never fires, so keep fetching automatically
  // until a finalized section appears or there are no more photos.
  useEffect( ( ) => {
    if ( !loading && hasNextPage && photos.length > 0 && galleryItems.length === 0 ) {
      loadMore( );
    }
  }, [loading, hasNextPage, photos.length, galleryItems.length, loadMore] );

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
          {`${formatDateStringFromTimestamp( item.timestamp )} (${item.nodes.length})`}
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
        {hasImportedPhotos && (
          <View className="flex-row items-center gap-2 px-2">
            { /* eslint-disable-next-line react-native/no-inline-styles */ }
            <Text style={{ fontSize: 12, color: colors.darkGray }}>
              {t( "Hide-already-saved-photos" )}
            </Text>
            <Switch
              value={hideImported}
              onValueChange={setHideImported}
              color={colors.inatGreen}
              testID="PhotoGallery.hideImported"
            />
          </View>
        )}
        <View className="flex-1" />
        {hasImportedPhotos && (
          <INatIconButton
            icon="date"
            onPress={selectSinceLastImport}
            accessibilityLabel={t( "Select-photos-since-last-import" )}
            disabled={photosSinceLastImport.length === 0}
            size={22}
            color={colors.darkGray}
            testID="PhotoGallery.selectSinceLastImport"
          />
        )}
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
