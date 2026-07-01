import { useNavigation, useRoute } from "@react-navigation/native";
import { fetchSpeciesCounts, searchObservations } from "api/observations";
import type { ApiObservation, ApiTaxon } from "api/types";
import { ActivityIndicator, Body1, Body4, DisplayTaxonName } from "components/SharedComponents";
import CustomFlashList from "components/SharedComponents/FlashList/CustomFlashList";
import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import { Pressable, View } from "components/styledComponents";
import type { TabStackScreenProps } from "navigation/types";
import React, { useEffect } from "react";
import Taxon from "realmModels/Taxon";
import Photo from "realmModels/Photo";
import { accessibleTaxonName } from "sharedHelpers/taxon";
import { useFontScale, useCurrentUser, useGridLayout, useTranslation, useAuthenticatedQuery } from "sharedHooks";

// Max page size the API allows
const PAGE_SIZE = 200;

interface Lifer {
  observed_on: string | null;
  uuid: string;
  observation_photos: ApiObservation["observation_photos"];
  taxon: ApiTaxon;
}

async function fetchLifers(
  userId: number | undefined,
  opts: { api_token: string | null },
): Promise<Lifer[]> {
  if ( !userId ) return [];

  // Cheap request (per_page: 0) for the total number of distinct species
  // this user has observed, so the paging loop below can stop as soon as
  // every species has been found instead of always scanning the user's
  // entire observation history.
  const { total_results: totalSpecies } = await fetchSpeciesCounts(
    { user_id: userId, per_page: 0 },
    opts,
  );

  // The API can't return "first observation per species" directly, so we
  // page through this user's observations oldest-to-newest and keep only
  // the first (i.e. oldest) observation we see of each species-level taxon.
  // Using the largest allowed page size keeps the number of requests to a minimum.
  const firstObservationBySpeciesId = new Map<number, Lifer>( );
  let page = 1;
  let hasMorePages = true;
  while ( hasMorePages ) {
    // eslint-disable-next-line no-await-in-loop
    const response = await searchObservations(
      {
        user_id: userId,
        order_by: "observed_on",
        order: "asc",
        per_page: PAGE_SIZE,
        page,
        fields: {
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
    } );
    hasMorePages = results.length === PAGE_SIZE
      && firstObservationBySpeciesId.size < totalSpecies;
    page += 1;
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
          key: `${route.key}-LiferGridItem-ObservationDetails-${item.uuid}`,
          name: "ObservationDetails",
          params: { id: item.uuid },
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

  const { data: lifers, isLoading } = useAuthenticatedQuery(
    ["fetchLifers", currentUser?.id],
    optsWithAuth => fetchLifers( currentUser?.id, optsWithAuth ),
    { enabled: !!currentUser },
  );

  useEffect( ( ) => {
    navigation.setOptions( { headerTitle: t( "MY-LIFERS" ) } );
  }, [navigation, t] );

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
