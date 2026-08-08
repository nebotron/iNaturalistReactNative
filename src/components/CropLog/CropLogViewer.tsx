/* eslint-disable i18next/no-literal-string */
import { INatIcon } from "components/SharedComponents";
import CachedImage from "components/SharedComponents/CachedImage";
import { Text, View } from "components/styledComponents";
import React, {
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import {
  deleteAnimalCrop,
  getAnimalCropLogAsArray,
} from "sharedHelpers/animalCropLog";
import detectSubjectInImage from "sharedHelpers/detectSubjectInImage";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";

const LABEL_COLOR = "#22c55e";
const DETECTOR_COLOR = "#eab308";

const styles = StyleSheet.create( {
  cropBox: {
    borderWidth: 2,
    position: "absolute",
  },
  deleteButton: {
    bottom: 8,
    position: "absolute",
    right: 8,
  },
  legendBox: {
    borderWidth: 2,
    height: 10,
    marginRight: 5,
    width: 10,
  },
  spinner: {
    bottom: 8,
    position: "absolute",
    right: 44,
  },
} );

interface Entry {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RowProps {
  entry: Entry;
  onDelete: () => void;
}

const Row = ( { entry, onDelete }: RowProps ) => {
  const { width: screenWidth } = useWindowDimensions();
  const [detectorCrop, setDetectorCrop] = useState<NormalizedCrop | null>( null );
  const [detecting, setDetecting] = useState( true );
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>( null );

  useEffect( ( ) => {
    let cancelled = false;
    setDetectorCrop( null );
    setDetecting( true );

    ( async ( ) => {
      try {
        const localUri = await ensureLocalImageForCrop( entry.url );
        const dims = await new Promise<{ w: number; h: number }>( ( resolve, reject ) => {
          Image.getSize( localUri, ( iw, ih ) => resolve( { w: iw, h: ih } ), reject );
        } );
        if ( !cancelled ) setImgDims( dims );
        const crop = await detectSubjectInImage( localUri, dims.w, dims.h );
        if ( !cancelled ) setDetectorCrop( crop );
      } catch {
        // detection failed — leave detectorCrop null
      } finally {
        if ( !cancelled ) setDetecting( false );
      }
    } )( );

    return ( ) => { cancelled = true; };
  }, [entry.url] );

  const displayWidth = screenWidth;
  const displayHeight = imgDims
    ? ( imgDims.h / imgDims.w ) * screenWidth
    : screenWidth;

  const clampRect = ( x: number, y: number, w: number, h: number ) => {
    const left = Math.min( Math.max( x, 0 ), 1 );
    const top = Math.min( Math.max( y, 0 ), 1 );
    const right = Math.min( Math.max( x + w, 0 ), 1 );
    const bottom = Math.min( Math.max( y + h, 0 ), 1 );
    return {
      height: ( bottom - top ) * displayHeight,
      left: left * displayWidth,
      top: top * displayHeight,
      width: ( right - left ) * displayWidth,
    };
  };

  const labelRect = clampRect( entry.x, entry.y, entry.w, entry.h );
  const detectorRect = detectorCrop
    && clampRect( detectorCrop.x, detectorCrop.y, detectorCrop.w, detectorCrop.h );

  return (
    <View style={{ height: displayHeight, width: displayWidth }}>
      <CachedImage
        source={{ uri: entry.url }}
        style={{ height: displayHeight, width: displayWidth }}
        resizeMode="fill"
      />
      <View
        pointerEvents="none"
        style={[styles.cropBox, { borderColor: LABEL_COLOR }, labelRect]}
      />
      {detectorRect && (
        <View
          pointerEvents="none"
          style={[styles.cropBox, { borderColor: DETECTOR_COLOR }, detectorRect]}
        />
      )}
      {detecting && (
        <ActivityIndicator size="small" style={styles.spinner} />
      )}
      <Pressable
        onPress={onDelete}
        className="p-2"
        style={styles.deleteButton}
        accessibilityLabel="Delete entry"
      >
        <INatIcon name="trash-outline" size={22} color="red" />
      </Pressable>
    </View>
  );
};

const ListHeader = ( { count }: { count: number } ) => (
  <View className="p-4 border-b border-lightGray">
    <Text className="text-sm font-bold mb-2">
      {`${count} ${count === 1
        ? "entry"
        : "entries"}`}
    </Text>
    <View className="flex-row items-center">
      <View style={[styles.legendBox, { borderColor: LABEL_COLOR }]} />
      <Text className="text-xs text-gray-500 mr-4">Ground truth</Text>
      <View style={[styles.legendBox, { borderColor: DETECTOR_COLOR }]} />
      <Text className="text-xs text-gray-500">AI detection</Text>
    </View>
  </View>
);

const ListEmpty = ( ) => (
  <View className="flex-1 items-center justify-center p-10">
    <Text className="text-gray-400">No crop log entries yet</Text>
  </View>
);

const CropLogViewer = ( ) => {
  // The app can't read the remote log (write-only sync, no credentials), so
  // the viewer shows this device's local log — the same entries it synced up.
  const [entries, setEntries] = useState<Entry[]>( ( ) => getAnimalCropLogAsArray( ) );
  const loading = false;

  const handleDelete = useCallback( ( url: string ) => {
    Alert.alert(
      "Delete Entry",
      "Remove this crop from the log?",
      [
        { style: "cancel", text: "Cancel" },
        {
          onPress: ( ) => {
            deleteAnimalCrop( url );
            setEntries( prev => prev.filter( e => e.url !== url ) );
          },
          style: "destructive",
          text: "Delete",
        },
      ],
    );
  }, [] );

  if ( loading ) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <FlatList
      data={entries}
      keyExtractor={item => item.url}
      renderItem={( { item } ) => (
        <Row entry={item} onDelete={( ) => handleDelete( item.url )} />
      )}
      ListHeaderComponent={<ListHeader count={entries.length} />}
      ListEmptyComponent={ListEmpty}
    />
  );
};

export default CropLogViewer;
