/* eslint-disable i18next/no-literal-string */
import { useNavigation } from "@react-navigation/native";
import SharedZoomableImage from "components/MediaViewer/SharedZoomableImage";
import { Text, TextInput, View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useMemo, useState } from "react";
import { FlatList, useWindowDimensions } from "react-native";
import Photo from "realmModels/Photo";
import type { RealmObservation, RealmPhoto } from "realmModels/types";
import type { PhotoCameraInfo } from "sharedHelpers/photoCameraInfo";
import { useBackfillCameraInfo } from "sharedHooks";

const { useQuery } = RealmContext;

type Setting = "focalLength" | "shutterSpeed" | "aperture" | "iso" | "focusDistance";
const SETTINGS: Setting[] = ["focalLength", "focusDistance", "shutterSpeed", "aperture", "iso"];
const MAX_PAIRS = 200;

interface Entry {
  uuid: string;
  taxonId: number;
  taxonName: string;
  photo: RealmPhoto;
  info: PhotoCameraInfo;
  values: Partial<Record<Setting, number>>;
}

interface Pair {
  key: string;
  a: Entry;
  b: Entry;
  // Difference in distance to subject, relative to the nearer photo
  score: number;
}

// "100 mm (160 mm equiv.)" → 160, "1/250 s" → 0.004, "f/5.6" → 5.6, "0.42 m" → 0.42
const parse = ( setting: Setting, raw = "" ): number | undefined => {
  const text = setting === "focalLength"
    ? raw.match( /\(([\d.]+) mm equiv/ )?.[1] ?? raw
    : raw;
  const fraction = text.match( /^1\/([\d.]+)/ );
  const value = fraction
    ? 1 / Number( fraction[1] )
    : parseFloat( text.replace( /^[^\d.]+/, "" ) );
  return Number.isFinite( value ) && value > 0
    ? value
    : undefined;
};

const differs = ( x?: string, y?: string ) => !!x && !!y && x !== y;

const compare = ( a: Entry, b: Entry ): number | null => {
  const x = a.values.focusDistance;
  const y = b.values.focusDistance;
  return x && y
    ? Math.abs( x - y ) / Math.min( x, y )
    : null;
};

// Swipe horizontally between the pair's photos; two fingers pinch/pan;
// one finger scrolls the list; tap opens the observation.
const PairItem = ( { pair, onOpen }: { pair: Pair; onOpen: ( uuid: string ) => void } ) => {
  const { width } = useWindowDimensions( );
  return (
    <View className="mb-6">
      <Text className="font-bold mb-2 px-4">{pair.a.taxonName}</Text>
      <FlatList
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        data={[pair.a, pair.b]}
        keyExtractor={( _entry, index ) => `${index}`}
        renderItem={( { item: entry } ) => (
          <SharedZoomableImage
            uri={Photo.displayLocalOrRemoteOriginalPhoto( entry.photo )}
            fullResolution
            style={{ width, height: width }}
            minScale={1}
            maxScale={20}
            isPinchEnabled
            isSingleFingerPanEnabled={false}
            isDoubleTapEnabled={false}
            isSingleTapEnabled
            onSingleTap={( ) => onOpen( entry.uuid )}
          />
        )}
      />
    </View>
  );
};

// Pairs of the user's photos of the same species taken with a different
// camera or lens at a similar distance, for comparing gear like-for-like.
const CameraPairs = ( ) => {
  const navigation = useNavigation( );
  const observations = useQuery<RealmObservation>( "Observation" );
  useBackfillCameraInfo( observations );
  // Per-session seed so left/right is random but stable across re-renders
  const [seed] = useState( ( ) => Math.random( ) * 1000 );
  const [toleranceText, setToleranceText] = useState( "20" );
  const tolerance = ( parseFloat( toleranceText ) || 0 ) / 100;

  const allPairs = useMemo( ( ) => {
    const byTaxon = new Map<number, Entry[]>( );
    observations.forEach( observation => {
      const { taxon } = observation;
      if ( !taxon?.id || ( taxon.rank_level ?? 0 ) > 10 ) return;
      observation.observationPhotos?.forEach( obsPhoto => {
        if ( !obsPhoto.cameraInfo ) return;
        let info: PhotoCameraInfo;
        try {
          info = JSON.parse( obsPhoto.cameraInfo );
        } catch {
          return;
        }
        const entries = byTaxon.get( taxon.id ) ?? [];
        entries.push( {
          uuid: observation.uuid,
          taxonId: taxon.id,
          taxonName: taxon.preferred_common_name || taxon.name,
          photo: obsPhoto.photo,
          info,
          values: Object.fromEntries( SETTINGS.map( s => [s, parse( s, info[s] )] ) ),
        } );
        byTaxon.set( taxon.id, entries );
      } );
    } );
    const pairs: Pair[] = [];
    byTaxon.forEach( entries => {
      for ( let i = 0; i < entries.length; i += 1 ) {
        for ( let j = i + 1; j < entries.length; j += 1 ) {
          const a = entries[i];
          const b = entries[j];
          if ( differs( a.info.camera, b.info.camera ) || differs( a.info.lens, b.info.lens ) ) {
            const score = compare( a, b );
            if ( score !== null ) {
              const flip = Math.sin( seed + a.taxonId + i * 12.9898 + j * 78.233 ) > 0;
              pairs.push( {
                key: `${a.taxonId}-${i}-${j}`,
                a: flip
                  ? b
                  : a,
                b: flip
                  ? a
                  : b,
                score,
              } );
            }
          }
        }
      }
    } );
    return pairs.sort( ( x, y ) => x.score - y.score );
  }, [observations, seed] );

  const pairs = useMemo(
    ( ) => allPairs.filter( pair => pair.score <= tolerance ).slice( 0, MAX_PAIRS ),
    [allPairs, tolerance],
  );

  const open = ( uuid: string ) => navigation.navigate( "ObsDetails", { uuid } );

  return (
    <FlatList
      className="bg-white"
      contentContainerClassName="py-4 pb-20"
      data={pairs}
      keyExtractor={pair => pair.key}
      ListHeaderComponent={(
        <View className="mb-4 px-4">
          <Text className="text-sm mb-2">
            Same species, different camera or lens, similar distance to subject.
            Max distance difference:
          </Text>
          <View className="flex-row items-center">
            <TextInput
              className="border border-lightGray rounded px-2 py-1 w-20"
              keyboardType="decimal-pad"
              value={toleranceText}
              onChangeText={setToleranceText}
              accessibilityLabel="Max distance difference percent"
            />
            <Text className="ml-1">%</Text>
          </View>
          <Text className="text-xs mt-2">
            {`${pairs.length}${pairs.length === MAX_PAIRS
              ? "+"
              : ""} pairs`}
          </Text>
        </View>
      )}
      ListEmptyComponent={(
        <Text className="text-center mt-10">
          No matching pairs among photos with camera info saved on this device.
        </Text>
      )}
      renderItem={( { item } ) => <PairItem pair={item} onOpen={open} />}
    />
  );
};

export default CameraPairs;
