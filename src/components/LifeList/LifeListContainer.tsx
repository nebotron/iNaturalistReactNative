import { useNavigation, useRoute } from "@react-navigation/native";
import { fetchRemoteObservations } from "api/observations";
import type { ApiObservation, ApiTaxon } from "api/types";
import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import {
  ActivityIndicator, Body1, Body4, DisplayTaxonName, Heading4, IconicTaxonChooser,
  RadioButtonSheet, RotatingINatIconButton,
} from "components/SharedComponents";
import SortButton from "components/SharedComponents/Buttons/SortButton";
import CustomFlashList from "components/SharedComponents/FlashList/CustomFlashList";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import { Pressable, View } from "components/styledComponents";
import type { TabStackScreenProps } from "navigation/types";
import React, {
  useCallback, useEffect, useMemo, useState,
} from "react";
import type { ListRenderItemInfo } from "react-native";
import Photo from "realmModels/Photo";
import { accessibleTaxonName } from "sharedHelpers/taxon";
import type { CachedObservation, UserObservationsCache } from "sharedHelpers/userObservationsCache";
import {
  OBSERVATION_SYNC_FIELDS,
  readUserObservationsCache,
  speciesIdFromTaxon,
  syncUserObservations,
} from "sharedHelpers/userObservationsCache";
import {
  useAuthenticatedQuery, useCurrentUser, useGridLayout, useTranslation,
} from "sharedHooks";
import { zustandStorage } from "stores/useStore";
import colors from "styles/tailwindColors";

import {
  readTaxonObservationsCounts,
  syncTaxonObservationsCounts,
} from "./taxonObservationsCounts";

// Max number of observations the API will fetch by uuid in one request.
const FETCH_BY_UUID_BATCH = 100;

enum LIFER_SORT {
  OBSERVED_ON_DESC = "OBSERVED_ON_DESC",
  RAREST = "RAREST",
}

interface Lifer {
  observed_on: string | null;
  uuid: string;
  observation_photos: ApiObservation["observation_photos"];
  // The taxon the observation was identified as, which is what the grid shows.
  taxon: ApiTaxon;
  // The species it records, which is the taxon itself unless the
  // identification went below species level. What makes it a lifer, and what
  // the global observations count is fetched for.
  speciesId: number | null;
  // How many observations of this species exist on iNaturalist. Undefined
  // until the count has been fetched at least once.
  observationsCount?: number;
}

// Which observation is a lifer is decided entirely from the shared observation
// cache (see userObservationsCache.ts), so this only has to hold the taxon and
// photo the grid renders. It's keyed by uuid and pruned to the current lifers,
// so it stays one entry per species rather than one per observation.
// v2 added speciesId to each entry, which v1 has no way to fill in.
const displayCacheKey = ( userId: number ) => `liferDisplay-v2-${userId}`;

type LiferDisplayCache = Record<string, Lifer>;

function readLiferDisplayCache( userId: number ): LiferDisplayCache {
  const raw = zustandStorage.getItem( displayCacheKey( userId ) );
  if ( typeof raw !== "string" ) return {};
  try {
    return JSON.parse( raw );
  } catch {
    return {};
  }
}

function writeLiferDisplayCache( userId: number, display: LiferDisplayCache ): void {
  zustandStorage.setItem( displayCacheKey( userId ), JSON.stringify( display ) );
  // The pre-shared-cache lifer list and the v1 display cache, which nothing
  // reads now. They held a full record per species, so they're worth
  // reclaiming rather than leaving on disk.
  zustandStorage.removeItem( `lifers-v2-${userId}` );
  zustandStorage.removeItem( `lifersLastSync-v2-${userId}` );
  zustandStorage.removeItem( `liferDisplay-v1-${userId}` );
}

const toLifer = ( obs: ApiObservation ): Lifer | null => (
  obs.taxon?.id
    ? {
      observed_on: obs.observed_on ?? null,
      uuid: obs.uuid,
      observation_photos: obs.observation_photos,
      taxon: obs.taxon,
      speciesId: speciesIdFromTaxon( obs.taxon ),
    }
    : null
);

// Only research-grade observations of a species count. An identification below
// species level still records its species, so it counts too — see
// speciesIdFromTaxon.
const isLiferCandidate = ( observation: CachedObservation ): boolean => (
  observation.researchGrade
  && !!observation.speciesId
);

// The earliest research-grade observation of each species, straight out of the
// shared cache. Recomputing from the whole cache rather than patching a stored
// list means a retraction simply stops qualifying and the next-earliest
// observation takes over, with no special case to handle it.
function earliestBySpecies( cache: UserObservationsCache ): Map<number, CachedObservation> {
  const earliest = new Map<number, CachedObservation>( );
  cache.forEach( observation => {
    if ( !isLiferCandidate( observation ) ) return;
    const speciesId = observation.speciesId as number;
    const existing = earliest.get( speciesId );
    const time = observation.observedAtMs ?? Number.MAX_SAFE_INTEGER;
    const existingTime = existing?.observedAtMs ?? Number.MAX_SAFE_INTEGER;
    if ( !existing || time < existingTime ) {
      earliest.set( speciesId, observation );
    }
  } );
  return earliest;
}

const sortByObservedOnDesc = ( lifers: Lifer[] ): Lifer[] => lifers.sort(
  ( a, b ) => (
    new Date( b.observed_on ?? 0 ).getTime( ) - new Date( a.observed_on ?? 0 ).getTime( )
  ),
);

// Species with no count yet sort last rather than looking like the rarest
// thing the user has ever seen.
const sortByRarest = ( lifers: Lifer[] ): Lifer[] => [...lifers].sort(
  ( a, b ) => ( a.observationsCount ?? Number.MAX_SAFE_INTEGER )
    - ( b.observationsCount ?? Number.MAX_SAFE_INTEGER ),
);

const withObservationsCounts = (
  lifers: Lifer[],
  counts: Record<number, number>,
): Lifer[] => lifers.map( lifer => ( {
  ...lifer,
  observationsCount: lifer.speciesId
    ? counts[lifer.speciesId]
    : undefined,
} ) );

// Fills in the taxon and photo for lifers we have no display data for. After a
// first sync every lifer was seen during the pass, so this does nothing; it
// only fires when a species' lifer changes to an older observation that wasn't
// in the pass (e.g. the previous one lost research grade).
async function fetchMissingDisplayData(
  uuids: string[],
  display: LiferDisplayCache,
  opts: { api_token: string | null },
): Promise<void> {
  for ( let i = 0; i < uuids.length; i += FETCH_BY_UUID_BATCH ) {
    const batch = uuids.slice( i, i + FETCH_BY_UUID_BATCH );
    // eslint-disable-next-line no-await-in-loop
    const results = await fetchRemoteObservations(
      batch,
      { fields: OBSERVATION_SYNC_FIELDS },
      opts,
    );
    ( results ?? [] ).forEach( ( obs: ApiObservation ) => {
      const lifer = toLifer( obs );
      if ( lifer ) {
        display[obs.uuid] = lifer;
      }
    } );
  }
}

// The lifers already derivable from the cache, for showing something
// immediately while a background sync checks for new ones.
function readCachedLifers( userId: number ): Lifer[] {
  const display = readLiferDisplayCache( userId );
  const liferUuids = new Set(
    Array.from( earliestBySpecies( readUserObservationsCache( userId ) ).values( ) )
      .map( observation => observation.uuid ),
  );
  return sortByObservedOnDesc(
    withObservationsCounts(
      Object.values( display ).filter( lifer => liferUuids.has( lifer.uuid ) ),
      readTaxonObservationsCounts( ),
    ),
  );
}

async function fetchLifers(
  userId: number | undefined,
  opts: { api_token: string | null },
): Promise<Lifer[]> {
  if ( !userId ) return [];

  const display = readLiferDisplayCache( userId );
  // Harvest what the grid renders from the same pass that fills the shared
  // cache, so a first sync needs no extra requests to be able to draw itself.
  const cache = await syncUserObservations( userId, opts, {
    onPage: results => results.forEach( obs => {
      if ( obs.quality_grade !== "research" ) return;
      const lifer = toLifer( obs );
      if ( lifer?.speciesId ) {
        display[obs.uuid] = lifer;
      }
    } ),
  } );

  const liferUuids = Array.from( earliestBySpecies( cache ).values( ) )
    .map( observation => observation.uuid );
  await fetchMissingDisplayData(
    liferUuids.filter( uuid => !display[uuid] ),
    display,
    opts,
  );

  // Keep only what's still a lifer, so this cache tracks the user's species
  // count rather than growing with every research-grade observation synced.
  const pruned: LiferDisplayCache = {};
  liferUuids.forEach( uuid => {
    if ( display[uuid] ) {
      pruned[uuid] = display[uuid];
    }
  } );
  writeLiferDisplayCache( userId, pruned );

  const lifers = Object.values( pruned );
  const counts = await syncTaxonObservationsCounts(
    [...new Set(
      lifers.map( lifer => lifer.speciesId ).filter( ( id ): id is number => Boolean( id ) ),
    )],
    opts,
  );

  return sortByObservedOnDesc( withObservationsCounts( lifers, counts ) );
}

interface LiferGridItemProps {
  item: Lifer;
  style?: object;
}

const LiferGridItem = ( { item, style }: LiferGridItemProps ) => {
  const navigation = useNavigation( );
  const { t } = useTranslation( );
  const currentUser = useCurrentUser( );
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
          { typeof item.observationsCount === "number" && (
            <Body4
              maxFontSizeMultiplier={1.5}
              numberOfLines={1}
              className="text-white pb-1"
            >
              {t( "X-Observations", { count: item.observationsCount } )}
            </Body4>
          ) }
          <DisplayTaxonName
            keyBase={`LiferGridItem-DisplayTaxonName-${item.taxon?.id}`}
            taxon={item.taxon}
            prefersCommonNames={currentUser?.prefers_common_names}
            layout="vertical"
            color="text-white"
            showOneNameOnly
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
          ? readCachedLifers( currentUser.id )
          : [];
        return cached.length
          ? cached
          : undefined;
      },
    },
  );

  // Empty means no filter, i.e. show every lifer
  const [iconicTaxonFilter, setIconicTaxonFilter] = useState<string[]>( [] );
  const [sortOption, setSortOption] = useState<LIFER_SORT>( LIFER_SORT.OBSERVED_ON_DESC );
  const [sortSheetVisible, setSortSheetVisible] = useState( false );

  const visibleLifers = useMemo( ( ) => {
    const filtered = iconicTaxonFilter.length === 0
      ? ( lifers ?? [] )
      : ( lifers ?? [] ).filter(
        lifer => iconicTaxonFilter.includes( lifer.taxon?.iconic_taxon_name?.toLowerCase( ) ?? "" ),
      );
    // fetchLifers already returns them newest first
    return sortOption === LIFER_SORT.RAREST
      ? sortByRarest( filtered )
      : filtered;
  }, [iconicTaxonFilter, lifers, sortOption] );

  const sortOptions = useMemo( ( ) => ( {
    [LIFER_SORT.OBSERVED_ON_DESC]: {
      label: t( "Most-Recent-Default" ),
      text: t( "Species-you-observed-most-recently-appear-first" ),
      value: LIFER_SORT.OBSERVED_ON_DESC,
    },
    [LIFER_SORT.RAREST]: {
      label: t( "Rarest" ),
      text: t( "Species-with-the-fewest-observations-on-iNaturalist-appear-first" ),
      value: LIFER_SORT.RAREST,
    },
  } ), [t] );

  // Tapping a chosen icon again clears it, so the filter can be undone without
  // a separate control
  const handleTaxonChosen = useCallback( ( iconicTaxonName: string ) => {
    setIconicTaxonFilter( chosen => ( chosen.includes( iconicTaxonName )
      ? chosen.filter( name => name !== iconicTaxonName )
      : [...chosen, iconicTaxonName] ) );
  }, [] );

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
      <View className="mt-5 px-4">
        <Heading4 className="mb-3">
          {t( "X-Species", { count: visibleLifers.length } )}
        </Heading4>
        <IconicTaxonChooser
          chosen={iconicTaxonFilter}
          onTaxonChosen={handleTaxonChosen}
          withoutUnknown
          testID="LifeList.IconicTaxonChooser"
        />
      </View>
      <View className="border-b border-lightGray mt-4" />
      <CustomFlashList
        data={visibleLifers}
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
              {iconicTaxonFilter.length > 0
                ? t( "No-results-found-try-different-search" )
                : t( "You-havent-observed-any-species-yet" )}
            </Body1>
          </View>
        )}
      />
      <SortButton
        onPress={( ) => setSortSheetVisible( true )}
        accessibilityLabel={t( "Change-species-sort-order" )}
      />
      {sortSheetVisible && (
        <RadioButtonSheet
          headerText={t( "SORT-SPECIES" )}
          radioValues={sortOptions}
          selectedValue={sortOption}
          confirm={optionId => {
            setSortOption( optionId as LIFER_SORT );
            setSortSheetVisible( false );
          }}
          onPressClose={( ) => setSortSheetVisible( false )}
        />
      )}
    </ScreenShell>
  );
};

export default LifeListContainer;
