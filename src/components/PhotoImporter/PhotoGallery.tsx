import {
  CameraRoll,
  iosRequestReadWriteGalleryPermission,
  type PhotoIdentifier,
} from "@react-native-camera-roll/camera-roll";
import { FlashList } from "@shopify/flash-list";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import INatIconButton from "components/SharedComponents/Buttons/INatIconButton";
import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import buildSectionedGalleryItems, {
  type PhotoGalleryListItem,
} from "components/PhotoImporter/helpers/photoGallerySections";
import { Body2 } from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
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
import {
  formatDateStringFromTimestamp,
  formatLongDatetime,
} from "sharedHelpers/dateAndTime";
import { getPreviouslyUploadedDevicePhotoUrisSet } from
  "sharedHelpers/duplicateUploadedDevicePhotos";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import { useGridLayout, useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

type PhotoNode = PhotoIdentifier["node"];

interface Props {
  fromAICamera?: boolean;
  isProcessing?: boolean;
  maxPhotos: number;
  onCancel: () => void;
  onDone: ( selectedNodes: PhotoNode[] ) => void;
}

const { useRealm } = RealmContext;

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
  fromAICamera = false,
  isProcessing = false,
  maxPhotos,
  onCancel,
  onDone,
}: Props ) => {
  const { t, i18n } = useTranslation( );
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
  const isFetchingRef = useRef( false );

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
        assetType: "Photos",
        after,
        include: ["filename", "fileSize", "filepath", "imageSize"],
      } );
      const nodes = result.edges.map( e => e.node );
      setPhotos( prev => ( after
        ? [...prev, ...nodes]
        : nodes ) );
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

  const handleDone = useCallback( ( ) => {
    const selected = photos.filter( node => selectedUris.has( getSelectionKey( node ) ) );
    onDone( selected );
  }, [photos, selectedUris, onDone] );

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

  const galleryItems = useMemo(
    ( ) => buildSectionedGalleryItems( photos, getSelectionKey ),
    [photos],
  );

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

  const renderItem = useCallback( ( { item }: { item: PhotoGalleryListItem } ) => {
    if ( item.type === "header" ) {
      const allSelected = item.nodes.length > 0
        && item.nodes.every( node => selectedUris.has( getSelectionKey( node ) ) );
      return (
        <View className="px-3 py-2 flex-row items-center justify-between">
          <Body2>
            {formatLongDatetime(
              formatDateStringFromTimestamp( item.timestamp ),
              i18n,
              { literalTime: true },
            )}
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
    }

    const { node } = item;
    const key = getSelectionKey( node );
    const selected = selectedUris.has( key );
    const imported = isImported( node );

    return (
      <Pressable
        accessibilityRole="button"
        onPress={( ) => toggleSelection( node )}
        testID={`PhotoGallery.${key}`}
      >
        <View className="relative">
          <ObsImagePreview
            source={{ uri: node.image.uri }}
            selected={selected}
            selectable
            hideGradientOverlay
            squareCorners
            style={gridItemStyle}
          />
          {imported && (
            <DuplicateUploadBadge
              accessibilityLabel={t( "Duplicate-photo-indicator" )}
              className="absolute top-2 left-2 z-10"
              size={20}
              testID={`PhotoGallery.imported.${key}`}
            />
          )}
        </View>
      </Pressable>
    );
  }, [
    selectedUris,
    isImported,
    toggleSelection,
    toggleSectionSelection,
    gridItemStyle,
    t,
    i18n,
  ] );

  const overrideItemLayout = useCallback( (
    layout: { span?: number },
    item: PhotoGalleryListItem,
  ) => {
    if ( item.type === "header" ) {
      layout.span = numColumns;
    }
  }, [numColumns] );

  if ( loading ) {
    return (
      <View className="flex-1 justify-center items-center">
        <ActivityIndicator />
      </View>
    );
  }

  if ( isProcessing ) {
    return (
      <View className="flex-1 justify-center items-center">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  const selectedCount = selectedUris.size;

  return (
    <View className="flex-1">
      <View
        className="flex-row items-center px-2 pt-2 pb-1"
      >
        <INatIconButton
          icon="close"
          onPress={onCancel}
          accessibilityLabel={t( "Cancel" )}
          size={22}
          color={colors.darkGray}
        />
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
        {selectedCount > 0 && (
          <INatIconButton
            icon="checkmark"
            onPress={handleDone}
            accessibilityLabel={t( "DONE" )}
            size={22}
            color={colors.inatGreen}
            testID="PhotoGallery.done"
          />
        )}
      </View>
      <FlashList
        data={galleryItems}
        numColumns={numColumns}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        getItemType={item => item.type}
        overrideItemLayout={overrideItemLayout}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        estimatedItemSize={gridItemWidth}
        extraData={{ selectedUris, importedUris }}
      />
    </View>
  );
};

export default PhotoGallery;
