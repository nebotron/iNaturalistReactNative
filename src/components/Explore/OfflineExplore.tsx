import { useNavigation } from "@react-navigation/native";
import type { ApiObservation, ApiTaxon } from "api/types";
import ExploreFlashList from "components/Explore/ExploreFlashList";
import ExploreV2SpeciesGridItem
  from "components/Explore/ExploreV2/components/ExploreV2SpeciesGridItem";
import ObservationsFlashList from "components/ObservationsFlashList/ObservationsFlashList";
import {
  Body3,
  Button,
} from "components/SharedComponents";
import { getMapRegion } from "components/SharedComponents/Map/helpers/mapHelpers";
import MapComponent from "components/SharedComponents/Map/Map";
import { View } from "components/styledComponents";
import LocationIndicatorIcon from "images/svg/location_indicator.svg";
import React, {
  useEffect, useMemo, useState, useSyncExternalStore,
} from "react";
import { Alert } from "react-native";
import type { BoundingBox } from "react-native-maps";
import { Marker, UrlTile } from "react-native-maps";
import {
  deleteOfflineExploreResults,
  downloadOfflineExploreResults,
  getOfflineExploreRealm,
  getOfflineExploreVersion,
  MAX_OFFLINE_OBSERVATIONS,
  MAX_TILE_ZOOM,
  OFFLINE_TILES_PATH,
  openOfflineExploreRealm,
  queryOfflineObservations,
  subscribeOfflineExploreResults,
} from "sharedHelpers/offlineExploreResults";
import { useTranslation } from "sharedHooks";
import useGridLayout from "sharedHooks/useGridLayout";
import { getShadow } from "styles/global";

const DROP_SHADOW = getShadow( { offsetHeight: 4, elevation: 6 } );
const OBS_LIST_CONTAINER_STYLE = { paddingTop: 50 };
const PAGE_SIZE = 100;
const noop = ( ) => undefined;
// Pins are native views, so cap them to keep the map responsive
const MAX_MAP_PINS = 1000;
const SPECIES_RANK_LEVEL = 10;
// Saved zooms to magnify past; wider areas are too coarse to be worth it
const OVERZOOM_LEVELS = Array.from(
  { length: MAX_TILE_ZOOM - 9 },
  ( _, i ) => i + 10,
);

type Params = Record<string, unknown>;

// Saved results matching params, re-queried whenever the saved results change
export const useOfflineExploreResults = ( params: Params ) => {
  useEffect( ( ) => { openOfflineExploreRealm( ); }, [] );
  const version = useSyncExternalStore(
    subscribeOfflineExploreResults,
    getOfflineExploreVersion,
  );
  return useMemo( ( ) => {
    const db = getOfflineExploreRealm( );
    if ( !db ) return null;
    const total = db.objects( "OfflineExploreObservation" ).length;
    if ( total === 0 ) return null;
    return { total, results: queryOfflineObservations( db, params ) };
  // version changes whenever the saved results do
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, version] );
};

interface SaveProps {
  // Resolves the current search's API params when saving
  getQueryParams: ( ) => Promise<Params>;
  disabled?: boolean;
}

// Adds the current search's results to the ones saved for offline use
export const SaveOfflineButton = ( { getQueryParams, disabled }: SaveProps ) => {
  const { t } = useTranslation( );
  const [progress, setProgress] = useState<number | null>( null );

  const save = async ( ) => {
    setProgress( 0 );
    try {
      const { added, total } = await downloadOfflineExploreResults(
        await getQueryParams( ),
        setProgress,
      );
      Alert.alert( t( "Added-X-offline-observations", { count: added, total } ) );
    } catch {
      Alert.alert( t( "Something-went-wrong" ) );
    } finally {
      setProgress( null );
    }
  };

  const onPress = ( ) => Alert.alert(
    t( "Save-for-offline-use" ),
    t( "Add-up-to-observations-from-this-search", { count: MAX_OFFLINE_OBSERVATIONS } ),
    [
      { text: t( "Cancel" ), style: "cancel" },
      { text: t( "SAVE" ), onPress: save },
    ],
  );

  return (
    <View className="px-4 mb-7">
      <Button
        text={progress === null
          ? t( "SAVE-RESULTS-FOR-OFFLINE-USE" )
          : t( "Saving-X-observations", { count: progress } )}
        disabled={disabled || progress !== null}
        loading={progress !== null}
        onPress={onPress}
        accessibilityLabel={t( "Save-for-offline-use" )}
        testID="SaveOfflineButton"
      />
    </View>
  );
};

interface ViewProps {
  layout: string | null;
  queryParams: Params;
}

// Shows saved results, filtered on device by the current Explore filters
export const OfflineObservationsView = ( { layout, queryParams }: ViewProps ) => {
  const { t } = useTranslation( );
  const saved = useOfflineExploreResults( queryParams );
  // Paging restarts when the filters change
  const [paging, setPaging] = useState( { params: queryParams, limit: PAGE_SIZE } );
  const limit = paging.params === queryParams
    ? paging.limit
    : PAGE_SIZE;
  // Parse only the rows the list has scrolled to
  const observations = useMemo(
    ( ) => ( saved?.results.slice( 0, limit ) || [] )
      .map( row => JSON.parse( row.json ) as ApiObservation ),
    [saved, limit],
  );
  if ( !saved ) return null;
  const listLayout = layout === "list"
    ? "list"
    : "grid";
  const onPressDelete = ( ) => Alert.alert( t( "Delete-offline-results" ), undefined, [
    { text: t( "Cancel" ), style: "cancel" },
    { text: t( "DELETE" ), style: "destructive", onPress: deleteOfflineExploreResults },
  ] );

  return (
    <View className="flex-1">
      <ObservationsFlashList
        contentContainerStyle={OBS_LIST_CONTAINER_STYLE}
        data={observations}
        explore
        handlePullToRefresh={noop}
        handleIndividualUploadPress={noop}
        hideLoadingWheel
        isConnected={false}
        layout={listLayout}
        obsListKey="OfflineExploreObservations"
        onEndReached={( ) => setPaging( { params: queryParams, limit: limit + PAGE_SIZE } )}
        showNoResults={saved.results.length === 0}
        hideObsUploadStatus={listLayout === "grid"}
        fullWidthGrid={listLayout === "grid"}
        testID="OfflineExploreObservations"
      />
      <View
        className="absolute bottom-5 right-5 z-10 bg-white rounded-full px-3 py-2"
        style={DROP_SHADOW}
      >
        <Body3 onPress={onPressDelete}>
          {t( "Offline-X-of-Y-saved-observations", {
            count: saved.results.length,
            total: saved.total,
          } )}
        </Body3>
      </View>
    </View>
  );
};

// Saved results as pins, since the observation tiles need the server
interface MapProps {
  queryParams: Params;
  onBoundsChange?: ( bounds: BoundingBox ) => void;
}

export const OfflineMapView = ( { queryParams, onBoundsChange }: MapProps ) => {
  const { t } = useTranslation( );
  const navigation = useNavigation( );
  const saved = useOfflineExploreResults( queryParams );
  const { pins, region } = useMemo( ( ) => {
    const located = saved?.results.filtered( "latitude != nil AND longitude != nil" );
    if ( !located?.length ) return { pins: [], region: undefined };
    return {
      pins: located.slice( 0, MAX_MAP_PINS ).map( ( {
        uuid, latitude, longitude, json,
      } ) => (
        { uuid, json, coordinate: { latitude: Number( latitude ), longitude: Number( longitude ) } }
      ) ),
      region: getMapRegion( {
        swlat: Number( located.min( "latitude" ) ),
        swlng: Number( located.min( "longitude" ) ),
        nelat: Number( located.max( "latitude" ) ),
        nelng: Number( located.max( "longitude" ) ),
      } ),
    };
  }, [saved] );

  return (
    <View className="flex-1 overflow-hidden h-full">
      <MapComponent
        initialRegion={region}
        isLoading={false}
        onRegionChangeComplete={( _region, bounds ) => bounds && onBoundsChange?.( bounds )}
        regionToAnimate={region}
        showCurrentLocationButton
        showsCompass={false}
        showSwitchMapTypeButton
        showScaleBar
        showsUserLocation
        switchMapTypeButtonClassName="right-5 bottom-20"
        mapChildren={(
          <>
            {/* Past a spot's most detailed saved tiles, magnify them instead of showing
              grey. One layer per saved zoom, most detailed on top, so each spot uses
              its own deepest level. Native tiles go on top, as a UrlTile rather than a
              LocalTile so they get the patched renderer that paints every tile on iOS. */}
            {OVERZOOM_LEVELS.map( z => (
              <UrlTile
                key={z}
                urlTemplate={`file://${OFFLINE_TILES_PATH}/{z}/{x}/{y}.png`}
                minimumZ={z + 1}
                maximumNativeZ={z}
                tileSize={256}
              />
            ) )}
            <UrlTile
              urlTemplate={`file://${OFFLINE_TILES_PATH}/{z}/{x}/{y}.png`}
              shouldReplaceMapContent
              tileSize={256}
            />
            {pins.map( ( { uuid, json, coordinate } ) => (
              <Marker
                key={uuid}
                coordinate={coordinate}
                tracksViewChanges={false}
                // Offline, ObsDetails can only show the saved observation
                onPress={( ) => navigation.navigate( "ObsDetails", {
                  uuid,
                  preloadedObservation: JSON.parse( json ),
                } )}
              >
                <LocationIndicatorIcon width={25} height={32} />
              </Marker>
            ) )}
          </>
        )}
      />
      <Body3 className="absolute bottom-1 right-2 text-xs">
        {t( "OpenStreetMap-contributors" )}
      </Body3>
    </View>
  );
};

interface SpeciesCount {
  count: number;
  taxon: ApiTaxon;
}

// Species counts of the saved results, like the server's species_counts
export const OfflineSpeciesView = ( { queryParams }: { queryParams: Params } ) => {
  const { flashListStyle, gridItemStyle, numColumns } = useGridLayout( );
  const saved = useOfflineExploreResults( queryParams );
  const species = useMemo( ( ) => {
    const observations = ( saved?.results || [] )
      .map( row => JSON.parse( row.json ) as ApiObservation );
    const counts = new Map<number, SpeciesCount>( );
    observations.forEach( ( { taxon, observation_photos: obsPhotos } ) => {
      if ( !taxon?.id || taxon.rank_level !== SPECIES_RANK_LEVEL ) return;
      const entry = counts.get( taxon.id );
      if ( entry ) {
        entry.count += 1;
      } else {
        // Saved taxa may have no photo of their own
        counts.set( taxon.id, {
          count: 1,
          taxon: { ...taxon, default_photo: taxon.default_photo || obsPhotos?.[0]?.photo },
        } );
      }
    } );
    // Subspecies and varieties count toward their species
    observations.forEach( ( { taxon } ) => {
      if ( !taxon?.rank_level || taxon.rank_level >= SPECIES_RANK_LEVEL ) return;
      const speciesId = taxon.ancestor_ids?.find( id => counts.has( id ) );
      const entry = speciesId && counts.get( speciesId );
      if ( entry ) entry.count += 1;
    } );
    const sorted = [...counts.values( )].sort( ( a, b ) => b.count - a.count );
    return queryParams.order === "asc"
      ? sorted.reverse( )
      : sorted;
  }, [saved, queryParams.order] );

  return (
    <ExploreFlashList
      contentContainerStyle={flashListStyle}
      data={species}
      fetchNextPage={noop}
      hideLoadingWheel
      isFetchingNextPage={false}
      isConnected={false}
      keyExtractor={( item: SpeciesCount ) => String( item.taxon.id )}
      layout="grid"
      numColumns={numColumns}
      // eslint-disable-next-line react/no-unused-prop-types
      renderItem={( { item }: { item: SpeciesCount } ) => (
        <ExploreV2SpeciesGridItem count={item.count} style={gridItemStyle} taxon={item.taxon} />
      )}
      totalResults={species.length}
      testID="OfflineExploreSpecies"
    />
  );
};
