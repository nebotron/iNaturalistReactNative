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
import { Pressable, View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Platform,
} from "react-native";
import { getPreviouslyUploadedDevicePhotoUrisSet } from
  "sharedHelpers/duplicateUploadedDevicePhotos";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import { useGridLayout, useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

type PhotoNode = PhotoIdentifier["node"];

interface Props {
  fromAICamera?: boolean;
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

const PhotoGallery = ( {
  fromAICamera = false,
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
  } = useGridLayout( );

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

  const getSelectionKey = ( node: PhotoNode ) => node.image.uri;

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

  const renderItem = useCallback( ( { item: node }: { item: PhotoNode } ) => {
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
  }, [selectedUris, isImported, toggleSelection, gridItemStyle, t] );

  if ( loading ) {
    return (
      <View className="flex-1 justify-center items-center">
        <ActivityIndicator />
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
        data={photos}
        numColumns={numColumns}
        renderItem={renderItem}
        keyExtractor={( node, index ) => `${node.image.uri}${index}`}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        estimatedItemSize={gridItemWidth}
        extraData={{ selectedUris, importedUris }}
      />
    </View>
  );
};

export default PhotoGallery;
