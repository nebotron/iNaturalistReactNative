import { useNavigation, useRoute } from "@react-navigation/native";
import { fetchSpeciesCounts, searchObservations } from "api/observations";
import type { ApiObservation, ApiTaxon } from "api/types";
import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import {
  ActivityIndicator, Body1, Body4, DisplayTaxonName, RotatingINatIconButton,
} from "components/SharedComponents";
import CustomFlashList from "components/SharedComponents/FlashList/CustomFlashList";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import { Pressable, View } from "components/styledComponents";
import type { TabStackScreenProps } from "navigation/types";
import React, { useCallback, useEffect } from "react";
import type { ListRenderItemInfo } from "react-native";
import Photo from "realmModels/Photo";
import Taxon from "realmModels/Taxon";
import { accessibleTaxonName } from "sharedHelpers/taxon";
import {
  useAuthenticatedQuery, useCurrentUser, useFontScale, useGridLayout, useTranslation,
} from "sharedHooks";
import { zustandStorage } from "stores/useStore";
import colors from "styles/tailwindColors";

// Max page size the API allows
const PAGE_SIZE = 200;

interface Lifer {
  observed_on: string | null;
  uuid: string;
  observation_photos: ApiObservation["observation_photos"];
  taxon: ApiTaxon;
}

// The lifer list is expensive to compute (it requires paging through a
// user's entire observation history), so once computed it's cached to disk
// forever, keyed by the time of the last sync. Subsequent fetches only need
// to look at observations created or updated since that time (e.g. newly
// uploaded, or newly reaching research grade) instead of recomputing the
// whole list from scratch.
// v2: research-grade-only, keyed by last sync time instead of max observation id
const cacheKey = ( userId: number ) => `lifers-v2-${userId}`;
const lastSyncCacheKey = ( userId: number ) => `lifersLastSync-v2-${userId}`;

function readCachedLifers( userId: number ): { lifers: Lifer[]; lastSync: string | null } {
  const rawLifers = zustandStorage.getItem( cacheKey( userId ) );
  return {
    lifers: rawLifers
      ? JSON.parse( rawLifers )
      : [],
    lastSync: zustandStorage.getItem( lastSyncCacheKey( userId ) ) || null,
  };
}

function writeCachedLifers( userId: number, lifers: Lifer[], lastSync: string ): void {
  zustandStorage.setItem( cacheKey( userId ), JSON.stringify( lifers ) );
  zustandStorage.setItem( lastSyncCacheKey( userId ), lastSync );
}

// Keep the earliest research-grade observation seen so far for a species.
function addLiferIfEarliest( map: Map<number, Lifer>, obs: ApiObservation ): void {
  const { taxon } = obs;
  // Only track species-level observations (rank_level === 10)
  if ( !taxon?.id || taxon.rank_level !== Taxon.SPECIES_LEVEL ) return;
  const existing = map.get( taxon.id );
  const observedOn = obs.observed_on ?? null;
  const isEarlier = observedOn && existing?.observed_on
    && new Date( observedOn ) < new Date( existing.observed_on );
  if ( !existing || isEarlier ) {
    map.set( taxon.id, {
      observed_on: observedOn,
      uuid: obs.uuid,
      observation_photos: obs.observation_photos,
      taxon,
    } );
  }
}

// Like addLiferIfEarliest, but also handles an observation that no longer
// qualifies (e.g. an ID was retracted and it dropped below research grade).
// If it was our recorded lifer for that species, remove it and flag the
// species so its remaining research-grade observations get re-checked.
function syncLiferFromUpdate(
  map: Map<number, Lifer>,
  obs: ApiObservation,
  speciesNeedingRecheck: Set<number>,
): void {
  const { taxon } = obs;
  if ( !taxon?.id || taxon.rank_level !== Taxon.SPECIES_LEVEL ) return;

  if ( obs.quality_grade !== "research" ) {
    const existing = map.get( taxon.id );
    if ( existing?.uuid === obs.uuid ) {
      map.delete( taxon.id );
      speciesNeedingRecheck.add( taxon.id );
    }
    return;
  }
  addLiferIfEarliest( map, obs );
  speciesNeedingRecheck.delete( taxon.id );
}

// Find the earliest remaining research-grade observation for a species
// whose previous lifer observation was retracted, if any is left.
async function recheckSpecies(
  map: Map<number, Lifer>,
  userId: number,
  taxonId: number,
  fields: object,
  opts: { api_token: string | null },
): Promise<void> {
  const response = await searchObservations(
    {
      user_id: userId,
      taxon_id: taxonId,
      quality_grade: "research",
      order_by: "observed_on",
      order: "asc",
      per_page: 1,
      fields,
    },
    opts,
  );
  const obs = response?.results?.[0];
  if ( obs ) addLiferIfEarliest( map, obs );
}

async function fetchLifers(
  userId: number | undefined,
  opts: { api_token: string | null },
): Promise<Lifer[]> {
  if ( !userId ) return [];

  const { lifers: cachedLifers, lastSync } = readCachedLifers( userId );
  const firstObservationBySpeciesId = new Map<number, Lifer>(
    cachedLifers.map( lifer => [lifer.taxon.id, lifer] ),
  );

  // Recorded before fetching so any observations that change again while
  // this sync is in flight get picked up by the next sync.
  const syncStartedAt = new Date( ).toISOString( );
  const fields = {
    id: true,
    observed_on: true,
    uuid: true,
    quality_grade: true,
    observation_photos: {
      photo: {
        url: true,
        license_code: true,
        attribution: true,
      },
    },
    taxon: Taxon.LIMITED_TAXON_FIELDS,
  };
  const commonParams = {
    user_id: userId,
    order_by: "id",
    order: "asc",
    per_page: PAGE_SIZE,
    fields,
  };

  if ( lastSync ) {
    // Only fetch observations created or updated since the last sync,
    // instead of re-paging through the user's entire observation history.
    // Grade isn't filtered server-side here so a retraction (an
    // observation dropping below research grade) is visible and can be
    // used to invalidate a stale cached lifer.
    const speciesNeedingRecheck = new Set<number>( );
    let page = 1;
    let hasMorePages = true;
    while ( hasMorePages ) {
      // eslint-disable-next-line no-await-in-loop
      const response = await searchObservations(
        { ...commonParams, updated_since: lastSync, page },
        opts,
      );
      const results: ApiObservation[] = response?.results ?? [];
      results.forEach( obs => (
        syncLiferFromUpdate( firstObservationBySpeciesId, obs, speciesNeedingRecheck )
      ) );
      hasMorePages = results.length === PAGE_SIZE;
      page += 1;
    }
    await Promise.all( Array.from( speciesNeedingRecheck ).map( taxonId => (
      recheckSpecies( firstObservationBySpeciesId, userId, taxonId, fields, opts )
    ) ) );
  } else {
    // First run: no prior sync to diff against, so the server can filter to
    // research grade directly. Cheap request (per_page: 0) for the total
    // number of distinct research-grade species this user has observed, so
    // the paging loop below can stop as soon as every species has been
    // found instead of paging to the end.
    const { total_results: totalSpecies } = await fetchSpeciesCounts(
      { user_id: userId, quality_grade: "research", per_page: 0 },
      opts,
    );

    let page = 1;
    let hasMorePages = true;
    while ( hasMorePages ) {
      // eslint-disable-next-line no-await-in-loop
      const response = await searchObservations(
        { ...commonParams, quality_grade: "research", page },
        opts,
      );
      const results: ApiObservation[] = response?.results ?? [];
      results.forEach( obs => addLiferIfEarliest( firstObservationBySpeciesId, obs ) );
      hasMorePages = results.length === PAGE_SIZE
        && firstObservationBySpeciesId.size < totalSpecies;
      page += 1;
    }
  }

  const lifers = Array.from( firstObservationBySpeciesId.values( ) ).sort(
    ( a, b ) => (
      new Date( b.observed_on ?? 0 ).getTime( ) - new Date( a.observed_on ?? 0 ).getTime( )
    ),
  );
  writeCachedLifers( userId, lifers, syncStartedAt );
  return lifers;
}

interface LiferGridItemProps {
  item: Lifer;
  style?: object;
}

const LiferGridItem = ( { item, style }: LiferGridItemProps ) => {
  const navigation = useNavigation( );
  const { t } = useTranslation( );
  const currentUser = useCurrentUser( );
  const { isLargeFontScale } = useFontScale();
  const route = useRoute( );
  const accessibleName = accessibleTaxonName( item.taxon, currentUser, t );

  // Get the photo from the first observation
  const firstObsPhoto = item.observation_photos?.[0]?.photo;
  const source = {
    uri: Photo.displayLocalOrRemoteMediumPhoto(
      firstObsPhoto,
    ),
  };

  const obsPhotosCount = firstObsPhoto
    ? 1
    : 0;

  return (
    <Pressable
      accessibilityRole="button"
      testID={`LiferGridItem.Pressable.${item.uuid}`}
      onPress={( ) => (
        navigation.navigate( {
          key: `${route.key}-LiferGridItem-ObsDetails-${item.uuid}`,
          name: "ObsDetails",
          params: { uuid: item.uuid },
        } )
      )}
      accessibilityLabel={accessibleName}
    >
      <ObsImagePreview
        source={source}
        style={style}
        isMultiplePhotosTop
        obsPhotosCount={obsPhotosCount}
        testID={`LiferGridItem.${item.uuid}`}
        iconicTaxonName={item.taxon.iconic_taxon_name}
      >
        <View className="absolute bottom-0 flex p-2 w-full">
          { item.observed_on && (
            <Body4
              maxFontSizeMultiplier={1.5}
              className="text-white py-1"
            >
              {item.observed_on}
            </Body4>
          ) }
          <DisplayTaxonName
            keyBase={`LiferGridItem-DisplayTaxonName-${item.taxon?.id}`}
            taxon={item.taxon}
            scientificNameFirst={currentUser?.prefers_scientific_name_first}
            prefersCommonNames={currentUser?.prefers_common_names}
            layout="vertical"
            color="text-white"
            showOneNameOnly={isLargeFontScale}
          />
        </View>
      </ObsImagePreview>
    </Pressable>
  );
};

const LifeListContainer = ( ) => {
  const navigation = useNavigation<TabStackScreenProps<"LifeList">["navigation"]>( );
  const currentUser = useCurrentUser( );
  const { t } = useTranslation( );
  const {
    flashListStyle,
    gridItemStyle,
    numColumns,
  } = useGridLayout( );

  const {
    data: lifers, isLoading, isFetching, refetch,
  } = useAuthenticatedQuery(
    ["fetchLifers", currentUser?.id],
    optsWithAuth => fetchLifers( currentUser?.id, optsWithAuth ),
    {
      enabled: !!currentUser,
      // Show the cached lifer list immediately, if we have one, while a
      // background fetch checks for any new lifers
      initialData: ( ) => {
        const cached = currentUser
          ? readCachedLifers( currentUser.id ).lifers
          : [];
        return cached.length
          ? cached
          : undefined;
      },
    },
  );

  const handleRefresh = useCallback( ( ) => {
    refetch( );
  }, [refetch] );

  const renderRefreshButton = useCallback( ( ) => (
    <RotatingINatIconButton
      icon="rotate-right"
      onPress={handleRefresh}
      color={String( colors?.darkGray )}
      rotating={isFetching}
      disabled={isFetching}
      accessibilityLabel={t( "Reset-verb" )}
      size={22}
      testID="LifersRefreshButton"
    />
  ), [handleRefresh, isFetching, t] );

  useEffect( ( ) => {
    navigation.setOptions( {
      headerTitle: t( "MY-LIFERS" ),
      headerRight: renderRefreshButton,
    } );
  }, [navigation, t, renderRefreshButton] );

  const renderItem = useCallback( ( { item }: ListRenderItemInfo<Lifer> ) => (
    <LiferGridItem
      item={item}
      style={gridItemStyle}
    />
  ), [gridItemStyle] );

  if ( isLoading ) {
    return (
      <ScreenShell>
        <ActivityIndicator size={50} />
      </ScreenShell>
    );
  }

  return (
    <ScreenShell>
      <View className="border-b border-lightGray mt-5" />
      <CustomFlashList
        data={lifers ?? []}
        numColumns={numColumns}
        contentContainerStyle={flashListStyle}
        keyExtractor={( item: Lifer ) => `${item.uuid}`}
        renderItem={renderItem}
        ListHeaderComponent={isFetching
          ? (
            <View className="items-center py-4">
              <ActivityIndicator />
            </View>
          )
          : null}
        ListEmptyComponent={(
          <View className="self-center mt-5 p-4">
            <Body1 className="align-center text-center">
              {t( "You-havent-observed-any-species-yet" )}
            </Body1>
          </View>
        )}
      />
    </ScreenShell>
  );
};

export default LifeListContainer;
