import { useNavigation, useRoute } from "@react-navigation/native";
import { fetchSpeciesCounts, searchObservations } from "api/observations";
import type { ApiObservation, ApiTaxon } from "api/types";
import { ActivityIndicator, Body1, Body4, DisplayTaxonName, RotatingINatIconButton } from "components/SharedComponents";
import CustomFlashList from "components/SharedComponents/FlashList/CustomFlashList";
import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import { Pressable, View } from "components/styledComponents";
import type { TabStackScreenProps } from "navigation/types";
import React, { useCallback, useEffect } from "react";
import Taxon from "realmModels/Taxon";
import Photo from "realmModels/Photo";
import { accessibleTaxonName } from "sharedHelpers/taxon";
import { useFontScale, useCurrentUser, useGridLayout, useTranslation, useAuthenticatedQuery } from "sharedHooks";
import colors from "styles/tailwindColors";
import { zustandStorage } from "stores/useStore";

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
// forever, keyed by the highest observation id seen so far. Subsequent
// fetches only need to look at observations newer than that id to find any
// new lifers, instead of recomputing the whole list from scratch.
const cacheKey = ( userId: number ) => `lifers-${userId}`;
const maxObservationIdCacheKey = ( userId: number ) => `lifersMaxObservationId-${userId}`;

function readCachedLifers( userId: number ): { lifers: Lifer[], maxObservationId: number } {
  const rawLifers = zustandStorage.getItem( cacheKey( userId ) );
  return {
    lifers: rawLifers ? JSON.parse( rawLifers ) : [],
    maxObservationId: Number( zustandStorage.getItem( maxObservationIdCacheKey( userId ) ) ) || 0,
  };
}

function writeCachedLifers( userId: number, lifers: Lifer[], maxObservationId: number ): void {
  zustandStorage.setItem( cacheKey( userId ), JSON.stringify( lifers ) );
  zustandStorage.setItem( maxObservationIdCacheKey( userId ), maxObservationId );
}

async function fetchLifers(
  userId: number | undefined,
  opts: { api_token: string | null },
): Promise<Lifer[]> {
  if ( !userId ) return [];

  const { lifers: cachedLifers, maxObservationId } = readCachedLifers( userId );
  const firstObservationBySpeciesId = new Map<number, Lifer>(
    cachedLifers.map( lifer => [lifer.taxon.id, lifer] ),
  );

  // Cheap request (per_page: 0) for the total number of distinct species
  // this user has observed, so we can tell whether the cached list is
  // already complete and, if not, the paging loop below can stop as soon as
  // every remaining species has been found.
  const { total_results: totalSpecies } = await fetchSpeciesCounts(
    { user_id: userId, per_page: 0 },
    opts,
  );

  if ( firstObservationBySpeciesId.size < totalSpecies ) {
    // The API can't return "first observation per species" directly, so we
    // page through observations newer than the newest one we've already
    // looked at and keep only the first (i.e. oldest) observation we see of
    // each species-level taxon we haven't already cached. Using the
    // largest allowed page size keeps the number of requests to a minimum.
    let newMaxObservationId = maxObservationId;
    let page = 1;
    let hasMorePages = true;
    while ( hasMorePages ) {
      // eslint-disable-next-line no-await-in-loop
      const response = await searchObservations(
        {
          user_id: userId,
          id_above: maxObservationId || undefined,
          order_by: "id",
          order: "asc",
          per_page: PAGE_SIZE,
          page,
          fields: {
            id: true,
            observed_on: true,
            uuid: true,
            observation_photos: {
              photo: {
                url: true,
                license_code: true,
                attribution: true,
              },
            },
            taxon: Taxon.LIMITED_TAXON_FIELDS,
          },
        },
        opts,
      );
      const results: ApiObservation[] = response?.results ?? [];
      results.forEach( obs => {
        const taxon = obs.taxon;
        // Only track species-level observations (rank_level === 10)
        if ( taxon?.id && taxon.rank_level === Taxon.SPECIES_LEVEL ) {
          if ( !firstObservationBySpeciesId.has( taxon.id ) ) {
            firstObservationBySpeciesId.set( taxon.id, {
              observed_on: obs.observed_on ?? null,
              uuid: obs.uuid,
              observation_photos: obs.observation_photos,
              taxon,
            } );
          }
        }
        if ( obs.id && obs.id > newMaxObservationId ) { newMaxObservationId = obs.id; }
      } );
      hasMorePages = results.length === PAGE_SIZE
        && firstObservationBySpeciesId.size < totalSpecies;
      page += 1;
    }

    writeCachedLifers(
      userId,
      Array.from( firstObservationBySpeciesId.values( ) ),
      newMaxObservationId,
    );
  }

  return Array.from( firstObservationBySpeciesId.values( ) ).sort(
    ( a, b ) => (
      new Date( b.observed_on ?? 0 ).getTime( ) - new Date( a.observed_on ?? 0 ).getTime( )
    ),
  );
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

  const obsPhotosCount = firstObsPhoto ? 1 : 0;

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

  const { data: lifers, isLoading, isFetching, refetch } = useAuthenticatedQuery(
    ["fetchLifers", currentUser?.id],
    optsWithAuth => fetchLifers( currentUser?.id, optsWithAuth ),
    {
      enabled: !!currentUser,
      // Show the cached lifer list immediately, if we have one, while a
      // background fetch checks for any new lifers
      initialData: ( ) => {
        const cached = currentUser ? readCachedLifers( currentUser.id ).lifers : [];
        return cached.length ? cached : undefined;
      },
    },
  );

  const handleRefresh = useCallback( ( ) => {
    if ( currentUser ) {
      zustandStorage.removeItem( cacheKey( currentUser.id ) );
      zustandStorage.removeItem( maxObservationIdCacheKey( currentUser.id ) );
    }
    refetch( );
  }, [currentUser, refetch] );

  useEffect( ( ) => {
    navigation.setOptions( {
      headerTitle: t( "MY-LIFERS" ),
      headerRight: ( ) => (
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
      ),
    } );
  }, [navigation, t, handleRefresh, isFetching] );

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
        renderItem={( { item }: { item: Lifer } ) => (
          <LiferGridItem
            item={item}
            style={gridItemStyle}
          />
        )}
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
