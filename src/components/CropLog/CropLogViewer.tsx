/* eslint-disable i18next/no-literal-string */
import { INatIcon } from "components/SharedComponents";
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
} from "react-native";
import {
  deleteAnimalCrop,
  getAnimalCropLogAsArray,
} from "sharedHelpers/animalCropLog";
import detectSubjectInImage from "sharedHelpers/detectSubjectInImage";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";

const THUMB = 120;
const LABEL_COLOR = "#22c55e";
const DETECTOR_COLOR = "#60a5fa";

const styles = StyleSheet.create( {
  cropBox: {
    borderWidth: 2,
    position: "absolute",
  },
  thumb: {
    height: THUMB,
    overflow: "hidden",
    width: THUMB,
  },
  thumbImg: {
    height: THUMB,
    width: THUMB,
  },
} );

interface Entry {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function fmtCrop( x: number, y: number, w: number, h: number ): string {
  return `x=${x.toFixed( 3 )} y=${y.toFixed( 3 )} w=${w.toFixed( 3 )} h=${h.toFixed( 3 )}`;
}

interface RowProps {
  entry: Entry;
  onDelete: () => void;
}

const Row = ( { entry, onDelete }: RowProps ) => {
  const [detectorCrop, setDetectorCrop] = useState<NormalizedCrop | null>( null );
  const [detecting, setDetecting] = useState( true );

  useEffect( ( ) => {
    let cancelled = false;
    setDetectorCrop( null );
    setDetecting( true );

    ( async ( ) => {
      try {
        const localUri = await ensureLocalImageForCrop( entry.url );
        const { w, h } = await new Promise<{ w: number; h: number }>( ( resolve, reject ) => {
          Image.getSize( localUri, ( iw, ih ) => resolve( { w: iw, h: ih } ), reject );
        } );
        const crop = await detectSubjectInImage( localUri, w, h );
        if ( !cancelled ) setDetectorCrop( crop );
      } catch {
        // detection failed — leave detectorCrop null
      } finally {
        if ( !cancelled ) setDetecting( false );
      }
    } )( );

    return ( ) => { cancelled = true; };
  }, [entry.url] );

  const labelRect = {
    left: entry.x * THUMB,
    top: entry.y * THUMB,
    width: entry.w * THUMB,
    height: entry.h * THUMB,
  };
  const detectorRect = detectorCrop && {
    left: detectorCrop.x * THUMB,
    top: detectorCrop.y * THUMB,
    width: detectorCrop.w * THUMB,
    height: detectorCrop.h * THUMB,
  };

  return (
    <View className="flex-row border-b border-lightGray p-3 items-start">
      <View style={styles.thumb}>
        <Image source={{ uri: entry.url }} style={styles.thumbImg} resizeMode="cover" />
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
      </View>
      <View className="flex-1 ml-3">
        <Text numberOfLines={3} className="text-xs text-gray-500 mb-2">{entry.url}</Text>
        <View className="flex-row items-center mb-1">
          <View
            style={{
              borderColor: LABEL_COLOR,
              borderWidth: 2,
              height: 8,
              marginRight: 6,
              width: 8,
            }}
          />
          <Text className="text-xs">{fmtCrop( entry.x, entry.y, entry.w, entry.h )}</Text>
        </View>
        <View className="flex-row items-center">
          <View
            style={{
              borderColor: DETECTOR_COLOR,
              borderWidth: 2,
              height: 8,
              marginRight: 6,
              width: 8,
            }}
          />
          {detecting
            ? <ActivityIndicator size="small" />
            : (
              <Text className="text-xs">
                {detectorCrop
                  ? fmtCrop( detectorCrop.x, detectorCrop.y, detectorCrop.w, detectorCrop.h )
                  : "—"}
              </Text>
            )}
        </View>
      </View>
      <Pressable
        onPress={onDelete}
        className="ml-2 p-2 justify-center"
        accessibilityLabel="Delete entry"
      >
        <INatIcon name="trash-outline" size={22} color="red" />
      </Pressable>
    </View>
  );
};

const ListHeader = ( { count }: { count: number } ) => (
  <View className="p-4 border-b border-lightGray">
    <Text className="text-sm font-bold mb-1">{`${count} ${count === 1 ? "entry" : "entries"}`}</Text>
    <View className="flex-row items-center">
      <View
        style={{
          borderColor: LABEL_COLOR,
          borderWidth: 2,
          height: 10,
          marginRight: 5,
          width: 10,
        }}
      />
      <Text className="text-xs text-gray-500 mr-4">My label</Text>
      <View
        style={{
          borderColor: DETECTOR_COLOR,
          borderWidth: 2,
          height: 10,
          marginRight: 5,
          width: 10,
        }}
      />
      <Text className="text-xs text-gray-500">Subject detector</Text>
    </View>
  </View>
);

const ListEmpty = ( ) => (
  <View className="flex-1 items-center justify-center p-10">
    <Text className="text-gray-400">No crop log entries yet</Text>
  </View>
);

const CropLogViewer = ( ) => {
  const [entries, setEntries] = useState<Entry[]>( getAnimalCropLogAsArray );

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
