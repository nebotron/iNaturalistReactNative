import { useNavigation } from "@react-navigation/native";
import { fetchSpeciesCounts, searchObservations } from "api/observations";
import type { ApiTaxon } from "api/types";
import {
  ActivityIndicator,
  Body1,
} from "components/SharedComponents";
import CustomFlashList from "components/SharedComponents/FlashList/CustomFlashList";
import TaxonGridItem from "components/SharedComponents/TaxonGridItem";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import { View } from "components/styledComponents";
import type { TabStackScreenProps } from "navigation/types";
import React, { useEffect } from "react";
import Taxon from "realmModels/Taxon";
import { formatApiDatetime } from "sharedHelpers/dateAndTime";
import {
  useAuthenticatedQuery,
  useCurrentUser,
  useGridLayout,
  useTranslation,
} from "sharedHooks";

// Max page size the API allows
const PAGE_SIZE = 200;

interface Lifer {
  observed_on: string | null;
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
  // the first (i.e. oldest) observation we see of each species. Using the
  // largest allowed page size keeps the number of requests to a minimum.
  const firstObservationByTaxonId = new Map<number, Lifer>( );
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
          taxon: Taxon.LIMITED_TAXON_FIELDS,
        },
      },
      opts,
    );
    const results: Lifer[] = response?.results ?? [];
    results.forEach( obs => {
      const taxonId = obs.taxon?.id;
      if ( taxonId && !firstObservationByTaxonId.has( taxonId ) ) {
        firstObservationByTaxonId.set( taxonId, obs );
      }
    } );
    hasMorePages = results.length === PAGE_SIZE
      && firstObservationByTaxonId.size < totalSpecies;
    page += 1;
  }

  return Array.from( firstObservationByTaxonId.values( ) ).sort(
    ( a, b ) => (
      new Date( b.observed_on ?? 0 ).getTime( ) - new Date( a.observed_on ?? 0 ).getTime( )
    ),
  );
}

const LifeListContainer = ( ) => {
  const navigation = useNavigation<TabStackScreenProps<"LifeList">["navigation"]>( );
  const currentUser = useCurrentUser( );
  const { t, i18n } = useTranslation( );
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
        keyExtractor={( item: Lifer ) => `${item.taxon.id}`}
        renderItem={( { item }: { item: Lifer } ) => (
          <TaxonGridItem
            style={gridItemStyle}
            taxon={item.taxon}
            headerText={formatApiDatetime( item.observed_on, i18n )}
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
