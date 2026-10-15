/* eslint-disable i18next/no-literal-string */
import { useNavigation } from "@react-navigation/native";
import {
  Body1, Body3, List2, SearchBar,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React, { useMemo, useState } from "react";
import { FlatList } from "react-native";

import type { AudioIdSpecies } from "./audioIdModel";
import useAudioIdSession from "./audioIdSession";

// Every taxon Audio ID is currently listening for, searchable by name.
const AudioIdTaxa = ( ) => {
  const navigation = useNavigation( );
  const setup = useAudioIdSession( state => state.setup );
  const [query, setQuery] = useState( "" );
  const filtered = useMemo( ( ) => {
    const q = query.trim( ).toLowerCase( );
    // Most likely at the user's place and week first.
    return ( setup?.species || [] )
      .map( ( sp, i ) => ( { sp, p: setup?.occurrence?.[i] ?? -1 } ) )
      .filter( ( { sp } ) => !q
        || sp.commonName.toLowerCase( ).includes( q )
        || sp.name.toLowerCase( ).includes( q ) )
      .sort( ( a, b ) => b.p - a.p || a.sp.commonName.localeCompare( b.sp.commonName ) )
      .map( ( { sp } ) => sp );
  }, [setup, query] );

  const renderItem = ( { item }: { item: AudioIdSpecies } ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens the species page."
      className="py-2 px-5 border-b border-lightGray"
      onPress={( ) => navigation.navigate( "TaxonDetails", { id: item.taxonId } )}
    >
      <Body1>{item.commonName}</Body1>
      <List2 className="italic">{item.name}</List2>
    </Pressable>
  );

  return (
    <View className="bg-white flex-1">
      <View className="px-5 py-3">
        <SearchBar
          autoFocus={false}
          value={query}
          handleTextChange={setQuery}
          clearSearch={( ) => setQuery( "" )}
          placeholder="Search"
        />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={item => String( item.taxonId )}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Body3 className="px-5 py-2">No matches.</Body3>}
      />
    </View>
  );
};

export default AudioIdTaxa;
