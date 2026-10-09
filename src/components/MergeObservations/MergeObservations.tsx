/* eslint-disable i18next/no-literal-string */
import { Body2, Button } from "components/SharedComponents";
import { RealmContext } from "providers/contexts";
import React, { useCallback, useState } from "react";
import {
  Alert, FlatList, Image, Pressable, StyleSheet, Text, useWindowDimensions, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Observation from "realmModels/Observation";
import Photo from "realmModels/Photo";
import type { RealmObservation } from "realmModels/types";
import mergeObservations from "sharedHelpers/mergeObservations";

const { useQuery, useRealm } = RealmContext;

const NUM_COLUMNS = 4;

const styles = StyleSheet.create( {
  cell: { padding: 1 },
  list: { paddingBottom: 100 },
} );

const MergeObservations = ( ) => {
  const realm = useRealm( );
  const { bottom } = useSafeAreaInsets( );
  const { width } = useWindowDimensions( );
  const size = width / NUM_COLUMNS;
  // Selection order matters: the first observation picked is the one kept
  const [selected, setSelected] = useState<string[]>( [] );

  const observations = useQuery(
    {
      type: Observation,
      query: obs => obs
        .filtered( "_pending_deletion != true" )
        .sorted( "_created_at", true ),
    },
    [],
  );

  const toggle = useCallback( ( uuid: string ) => setSelected( current => (
    current.includes( uuid )
      ? current.filter( u => u !== uuid )
      : [...current, uuid]
  ) ), [] );

  const merge = ( ) => {
    const [target, ...sources] = selected
      .map( uuid => realm.objectForPrimaryKey<RealmObservation>( "Observation", uuid ) )
      .filter( Boolean ) as RealmObservation[];
    if ( !target || sources.length === 0 ) return;
    Alert.alert(
      `Merge ${selected.length} observations?`,
      "Photos and sounds move into the first one you selected, and the others are deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Merge",
          style: "destructive",
          onPress: ( ) => {
            mergeObservations( realm, target, sources );
            setSelected( [] );
          },
        },
      ],
    );
  };

  const renderItem = ( { item }: { item: RealmObservation } ) => {
    const index = selected.indexOf( item.uuid );
    const photo = item.observationPhotos?.[0]?.photo;
    const uri = photo && Photo.displayLocalOrRemoteSquarePhoto( photo );
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: index >= 0 }}
        onPress={( ) => toggle( item.uuid )}
        style={[styles.cell, { width: size, height: size }]}
      >
        {uri
          ? <Image source={{ uri }} className="flex-1" accessibilityIgnoresInvertColors />
          : <View className="flex-1 bg-lightGray" />}
        {index >= 0 && (
          <View className="absolute inset-[1px] border-4 border-inatGreen items-start">
            <Text className="bg-inatGreen text-white font-bold px-1">
              {index === 0
                ? "KEEP"
                : index + 1}
            </Text>
          </View>
        )}
      </Pressable>
    );
  };

  return (
    <View className="flex-1 bg-white">
      <Body2 className="p-3">
        Tap observations to merge. The first one you tap is kept.
      </Body2>
      <FlatList
        data={observations}
        numColumns={NUM_COLUMNS}
        keyExtractor={item => item.uuid}
        renderItem={renderItem}
        extraData={selected}
        contentContainerStyle={styles.list}
      />
      <View className="absolute left-4 right-4" style={{ bottom: bottom + 16 }}>
        <Button
          level="focus"
          text={`MERGE ${selected.length} OBSERVATIONS`}
          disabled={selected.length < 2}
          onPress={merge}
        />
      </View>
    </View>
  );
};

export default MergeObservations;
