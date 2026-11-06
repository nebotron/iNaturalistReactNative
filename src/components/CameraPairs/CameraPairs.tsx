import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { SharedZoomableImageRef } from "components/MediaViewer/SharedZoomableImage";
import SharedZoomableImage from "components/MediaViewer/SharedZoomableImage";
import {
  Pressable, Text, TextInput, View,
} from "components/styledComponents";
import i18n from "i18next";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { FlatList, useWindowDimensions } from "react-native";
import Photo from "realmModels/Photo";
import type { RealmObservation, RealmPhoto } from "realmModels/types";
import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import type { PhotoCameraInfo } from "sharedHelpers/photoCameraInfo";
import { useBackfillCameraInfo, useTranslation } from "sharedHooks";
import { zustandStorage } from "stores/useStore";

const { useQuery } = RealmContext;

type Setting = "focalLength" | "shutterSpeed" | "aperture" | "iso" | "focusDistance";
const SETTINGS: Setting[] = ["focalLength", "focusDistance", "shutterSpeed", "aperture", "iso"];
const VOTES_KEY = "camera-pair-votes";
const ZOOMS_KEY = "camera-pair-zooms";

interface Entry {
  uuid: string;
  // ObservationPhoto uuid, stable across sessions
  photoUuid: string;
  gear: string;
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

// Which gear won a pair, keyed by the pair's sorted photo uuids. Gear labels
// are stored with the vote so the tally survives photos leaving the list.
interface Vote {
  gear: [string, string];
  winner: string | "same";
}
type Votes = Record<string, Vote>;

const loadVotes = ( ): Votes => {
  const raw = zustandStorage.getItem( VOTES_KEY );
  if ( typeof raw !== "string" ) return {};
  try {
    return JSON.parse( raw ) as Votes;
  } catch {
    return {};
  }
};

// Pinch/pan position per photo, with the tile size it was set at. Offsets are
// in pixels and scale with the square tile, so a different width rescales them.
interface SavedZoom {
  size: number;
  transform: ImageZoomTransform;
}
let savedZooms: Record<string, SavedZoom> | undefined;
const loadZooms = ( ): Record<string, SavedZoom> => {
  if ( savedZooms ) return savedZooms;
  const raw = zustandStorage.getItem( ZOOMS_KEY );
  try {
    savedZooms = typeof raw === "string"
      ? JSON.parse( raw ) as Record<string, SavedZoom>
      : {};
  } catch {
    savedZooms = {};
  }
  return savedZooms;
};
const saveZoom = ( photoUuid: string, zoom: SavedZoom ) => {
  const zooms = loadZooms( );
  if ( zoom.transform.scale <= 1.001 ) {
    delete zooms[photoUuid];
  } else {
    zooms[photoUuid] = zoom;
  }
  zustandStorage.setItem( ZOOMS_KEY, JSON.stringify( zooms ) );
};

const gearLabel = ( info: PhotoCameraInfo ) => [info.camera, info.lens]
  .filter( Boolean ).join( " + " ) || i18n.t( "Unknown-gear" );

const voteKey = ( pair: Pair ) => [pair.a.photoUuid, pair.b.photoUuid].sort( ).join( "|" );

// Same key the preference breakdown uses for a gear combination
const gearKey = ( pair: Pair ) => [pair.a.gear, pair.b.gear].sort( ).join( "|" );

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

// A crop context makes the zoom engine keep the transform on release
// instead of snapping back. The position is saved per photo on release and
// restored on mount, so it survives list recycling, navigation and relaunch.
const PairPhoto = ( { entry, size, onOpen }: {
  entry: Entry; size: number; onOpen: ( uuid: string ) => void;
} ) => {
  const [dims, setDims] = useState<{ width: number; height: number }>( );
  const zoomRef = useRef<SharedZoomableImageRef | null>( null );
  const { photoUuid } = entry;

  useEffect( ( ) => {
    const saved = loadZooms( )[photoUuid];
    if ( !saved || !zoomRef.current || size <= 0 || saved.size <= 0 ) return;
    const ratio = size / saved.size;
    const { transform } = saved;
    zoomRef.current.applyTransform( {
      scale: transform.scale,
      translateX: transform.translateX * ratio,
      translateY: transform.translateY * ratio,
      focalX: transform.focalX * ratio,
      focalY: transform.focalY * ratio,
    } );
  }, [photoUuid, size] );

  const rememberZoom = useCallback( ( ) => {
    if ( !zoomRef.current || size <= 0 ) return;
    saveZoom( photoUuid, { size, transform: zoomRef.current.readTransform( ) } );
  }, [photoUuid, size] );

  return (
    <SharedZoomableImage
      ref={zoomRef}
      uri={Photo.displayLocalOrRemoteOriginalPhoto( entry.photo )}
      fullResolution
      style={{ width: size, height: size }}
      minScale={1}
      maxScale={20}
      isPinchEnabled
      isSingleFingerPanEnabled={false}
      isDoubleTapEnabled={false}
      isSingleTapEnabled
      onSingleTap={( ) => onOpen( entry.uuid )}
      onImageDimensionsChange={setDims}
      onInteractionEnd={rememberZoom}
      cropPanContext={dims && {
        imageWidth: dims.width,
        imageHeight: dims.height,
        viewportWidth: size,
        viewportHeight: size,
        cropSize: size,
      }}
    />
  );
};

// Swipe horizontally between the pair's photos; two fingers pinch/pan;
// one finger scrolls the list; tap opens the observation.
const VoteButton = ( { label, selected, onPress }: {
  label: string; selected: boolean; onPress: ( ) => void;
} ) => (
  <Pressable
    accessibilityRole="button"
    accessibilityState={{ selected }}
    onPress={onPress}
    className={`flex-1 mx-1 py-2 rounded border ${selected
      ? "bg-inatGreen border-inatGreen"
      : "border-lightGray"}`}
  >
    <Text className={`text-center text-sm ${selected
      ? "text-white font-bold"
      : ""}`}
    >
      {label}
    </Text>
  </Pressable>
);

const FIRST_COLOR = "#2563EB";
const SAME_COLOR = "#BFBFBF";
const SECOND_COLOR = "#DC2626";

// One stretch of a preference bar, sized by and labeled with its vote count
const BarSegment = ( { count, color, darkText = false }: {
  count: number; color: string; darkText?: boolean;
} ) => ( count > 0
  ? (
    <View className="justify-center" style={{ flex: count, backgroundColor: color }}>
      <Text
        numberOfLines={1}
        className={`text-xs font-bold text-center ${darkText
          ? "text-darkGray"
          : "text-white"}`}
      >
        {count}
      </Text>
    </View>
  )
  : null );

const PairItem = ( {
  pair, vote, onOpen, onVote,
}: {
  pair: Pair;
  vote?: Vote;
  onOpen: ( uuid: string ) => void;
  onVote: ( pair: Pair, winner: string | "same" ) => void;
} ) => {
  const { t } = useTranslation( );
  const { width } = useWindowDimensions( );
  const [page, setPage] = useState( 0 );
  const sameGear = pair.a.gear === pair.b.gear;
  return (
    <View className="mb-6">
      <Text className="font-bold mb-2 px-4">{pair.a.taxonName}</Text>
      <FlatList
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        data={[pair.a, pair.b]}
        keyExtractor={( _entry, index ) => `${index}`}
        onMomentumScrollEnd={e => setPage(
          Math.round( e.nativeEvent.contentOffset.x / width ),
        )}
        renderItem={( { item: entry } ) => (
          <PairPhoto entry={entry} size={width} onOpen={onOpen} />
        )}
      />
      <Text className="text-xs text-center mt-1">
        {t( "Photo-X-of-Y-swipe-to-compare", { number: page + 1, total: 2 } )}
      </Text>
      {!sameGear && (
        <View className="flex-row mt-2 px-3">
          <VoteButton
            label={t( "Photo-X-is-better", { number: 1 } )}
            selected={vote?.winner === pair.a.gear}
            onPress={( ) => onVote( pair, pair.a.gear )}
          />
          <VoteButton
            label={t( "Similar--comparison" )}
            selected={vote?.winner === "same"}
            onPress={( ) => onVote( pair, "same" )}
          />
          <VoteButton
            label={t( "Photo-X-is-better", { number: 2 } )}
            selected={vote?.winner === pair.b.gear}
            onPress={( ) => onVote( pair, pair.b.gear )}
          />
        </View>
      )}
    </View>
  );
};

// Pairs of the user's photos of the same species taken with a different
// camera or lens at a similar distance, for comparing gear like-for-like.
const CameraPairs = ( ) => {
  const { t } = useTranslation( );
  const navigation = useNavigation( );
  const observations = useQuery<RealmObservation>( "Observation" );
  useBackfillCameraInfo( observations );
  // Per-session seed so left/right is random but stable across re-renders
  const [seed] = useState( ( ) => Math.random( ) * 1000 );
  const [toleranceText, setToleranceText] = useState( "20" );
  const tolerance = ( parseFloat( toleranceText ) || 0 ) / 100;
  // Gear combination picked by tapping its preference bar
  const [gearFilter, setGearFilter] = useState<string | null>( null );

  const allPairs = useMemo( ( ) => {
    const byTaxon = new Map<number, Entry[]>( );
    observations.forEach( observation => {
      const { taxon } = observation;
      if ( !taxon?.id || ( taxon.rank_level ?? 0 ) > 10 ) return;
      // Only the first photo represents the observation
      const obsPhoto = observation.observationPhotos?.[0];
      if ( !obsPhoto?.cameraInfo ) return;
      let info: PhotoCameraInfo;
      try {
        info = JSON.parse( obsPhoto.cameraInfo );
      } catch {
        return;
      }
      const entries = byTaxon.get( taxon.id ) ?? [];
      entries.push( {
        uuid: observation.uuid,
        photoUuid: obsPhoto.uuid,
        gear: gearLabel( info ),
        taxonId: taxon.id,
        taxonName: taxon.preferred_common_name || taxon.name,
        photo: obsPhoto.photo,
        info,
        values: Object.fromEntries( SETTINGS.map( s => [s, parse( s, info[s] )] ) ),
      } );
      byTaxon.set( taxon.id, entries );
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

  const open = ( uuid: string ) => navigation.navigate( "ObsDetails", { uuid } );

  const [votes, setVotes] = useState<Votes>( loadVotes );
  // Pairs decided as of the last time the screen gained focus. Snapshotting
  // keeps the list from reshuffling under the user while they vote; on
  // return, undecided pairs move to the top.
  const [decided, setDecided] = useState( ( ) => new Set( Object.keys( votes ) ) );
  useFocusEffect( useCallback( ( ) => {
    setDecided( new Set( Object.keys( loadVotes( ) ) ) );
  }, [] ) );

  const pairs = useMemo( ( ) => {
    const within = allPairs.filter( pair => pair.score <= tolerance );
    // Stable sort, so each group keeps its closest-distance-first order
    return within.sort( ( x, y ) => Number( decided.has( voteKey( x ) ) )
      - Number( decided.has( voteKey( y ) ) ) );
  }, [allPairs, tolerance, decided] );

  const castVote = useCallback( ( pair: Pair, winner: string | "same" ) => {
    setVotes( current => {
      const key = voteKey( pair );
      const next = { ...current };
      if ( next[key]?.winner === winner ) {
        // Tapping the selected choice again clears it
        delete next[key];
      } else {
        next[key] = {
          gear: [pair.a.gear, pair.b.gear].sort( ) as [string, string],
          winner,
        };
      }
      zustandStorage.setItem( VOTES_KEY, JSON.stringify( next ) );
      return next;
    } );
  }, [] );

  const breakdown = useMemo( ( ) => {
    const rows = new Map<string, {
      first: string; second: string; firstWins: number; secondWins: number; same: number;
    }>( );
    Object.values( votes ).forEach( ( { gear: [first, second], winner } ) => {
      const key = `${first}|${second}`;
      const row = rows.get( key ) ?? {
        first, second, firstWins: 0, secondWins: 0, same: 0,
      };
      if ( winner === "same" ) row.same += 1;
      else if ( winner === first ) row.firstWins += 1;
      else if ( winner === second ) row.secondWins += 1;
      rows.set( key, row );
    } );
    return [...rows.values( )].sort( ( x, y ) => (
      ( y.firstWins + y.secondWins + y.same ) - ( x.firstWins + x.secondWins + x.same )
    ) );
  }, [votes] );

  // Ignore a filter whose bar went away when its last vote was cleared,
  // so the list can't get stuck filtered with nothing to tap
  const activeFilter = gearFilter
    && breakdown.some( row => `${row.first}|${row.second}` === gearFilter )
    ? gearFilter
    : null;
  const shownPairs = useMemo( ( ) => ( activeFilter
    ? pairs.filter( pair => gearKey( pair ) === activeFilter )
    : pairs ), [pairs, activeFilter] );

  return (
    <FlatList
      className="bg-white"
      contentContainerClassName="py-4 pb-20"
      data={shownPairs}
      keyExtractor={pair => pair.key}
      extraData={votes}
      ListHeaderComponent={(
        <View className="mb-4 px-4">
          {breakdown.length > 0 && (
            <View className="mb-4">
              <Text className="font-bold mb-2">{t( "Your-preferences" )}</Text>
              {breakdown.map( row => {
                const key = `${row.first}|${row.second}`;
                const selected = activeFilter === key;
                // Each gear is labeled once, under its own half of the bar.
                // Tapping a bar shows only that combination's pairs; tapping
                // it again shows all pairs.
                return (
                  <Pressable
                    key={key}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={t( "X-vs-Y", { first: row.first, second: row.second } )}
                    accessibilityHint={selected
                      ? t( "Shows-all-pairs" )
                      : t( "Shows-only-pairs-with-this-gear" )}
                    onPress={( ) => setGearFilter( selected
                      ? null
                      : key )}
                    className={`mb-3 ${activeFilter && !selected
                      ? "opacity-40"
                      : ""}`}
                  >
                    <View className="flex-row h-6 rounded overflow-hidden bg-lightGray">
                      <BarSegment count={row.firstWins} color={FIRST_COLOR} />
                      <BarSegment count={row.same} color={SAME_COLOR} darkText />
                      <BarSegment count={row.secondWins} color={SECOND_COLOR} />
                    </View>
                    <View className="flex-row mt-1">
                      <Text className="flex-1 pr-2 text-xs font-bold">{row.first}</Text>
                      <Text className="flex-1 pl-2 text-xs font-bold text-right">
                        {row.second}
                      </Text>
                    </View>
                  </Pressable>
                );
              } )}
            </View>
          )}
          <Text className="text-sm mb-2">
            {t( "Camera-pairs-explanation" )}
          </Text>
          <View className="flex-row items-center">
            <TextInput
              className="border border-lightGray rounded px-2 py-1 w-20"
              keyboardType="decimal-pad"
              value={toleranceText}
              onChangeText={setToleranceText}
              accessibilityLabel={t( "Max-distance-difference-percent" )}
            />
            <Text className="ml-1">{t( "Percent-sign" )}</Text>
          </View>
          <Text className="text-xs mt-2">
            {t( "X-pairs", { count: shownPairs.length } )}
          </Text>
        </View>
      )}
      ListEmptyComponent={(
        <Text className="text-center mt-10">
          {t( "No-matching-camera-pairs" )}
        </Text>
      )}
      renderItem={( { item } ) => (
        <PairItem
          pair={item}
          vote={votes[voteKey( item )]}
          onOpen={open}
          onVote={castVote}
        />
      )}
    />
  );
};

export default CameraPairs;
