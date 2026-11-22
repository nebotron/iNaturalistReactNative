import { useQueries } from "@tanstack/react-query";
import { SPECIES_COUNTS_SUMMARY_FIELDS } from "api/fields";
import { fetchSpeciesCounts } from "api/observations";
import type { ApiSpeciesCountSummary, ApiTaxon } from "api/types";
import ExploreFlashList from "components/Explore/ExploreFlashList";
import ExploreV2SpeciesGridItem
  from "components/Explore/ExploreV2/components/ExploreV2SpeciesGridItem";
import TaxonomicOrderNotice
  from "components/Explore/ExploreV2/components/TaxonomicOrderNotice";
import type {
  ExploreV2BaseQueryParams,
} from "components/Explore/ExploreV2/helpers/buildQueryParams";
import { View } from "components/styledComponents";
import i18n from "i18next";
import React, { useCallback, useMemo } from "react";
import Taxon from "realmModels/Taxon";
import { handleRetryDelay, reactQueryRetry } from "sharedHelpers/logging";
import type { SpeciesCountsSortAPIParams } from "sharedHelpers/speciesSort";
import {
  EXPLORE_TAXONOMIC_SPECIES_LIMIT,
  sortByTaxonomyWithKey,
} from "sharedHelpers/taxonomicSort";
import useCurrentUser from "sharedHooks/useCurrentUser";
import useFetchPagesUpTo from "sharedHooks/useFetchPagesUpTo";
import useGridLayout from "sharedHooks/useGridLayout";
import useInfiniteScroll from "sharedHooks/useInfiniteScroll";
import { useLineages } from "sharedHooks/useTaxonomicLineages";

export type SpeciesCountQueryParams = ExploreV2BaseQueryParams & SpeciesCountsSortAPIParams;

interface SpeciesCountResult {
  count: number;
  taxon: ApiTaxon;
}

interface Props {
  // Taxonomic order: the most observed species, loaded up front and sorted on device
  byTaxonomy?: boolean;
  enabled: boolean;
  isConnected: boolean | null;
  params: SpeciesCountQueryParams;
  // See CustomFlashList
  scrollRestoreKey?: string;
}

// One seen-query per infinite-scroll page: the seen-id chunks are sized to
// SPECIES_PAGE_SIZE so each chunk aligns to exactly one loaded page
const SPECIES_PAGE_SIZE = 10;
// The most species_counts returns in a page
const TAXONOMIC_PAGE_SIZE = 500;
// Taxonomic order checks which species the user has seen in fewer, bigger requests
const TAXONOMIC_SEEN_CHUNK_SIZE = 100;

const speciesKey = ( item: SpeciesCountResult ) => String( item.taxon.id );

const ExploreV2SpeciesView = ( {
  byTaxonomy = false, enabled, isConnected, params, scrollRestoreKey,
}: Props ) => {
  const currentUser = useCurrentUser( );
  const { flashListStyle, gridItemStyle, numColumns } = useGridLayout( );

  // Signed-out users have no account locale, so common names need the app
  // language passed explicitly
  const locale = i18n?.language ?? "en";

  const {
    data,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    totalResults,
  } = useInfiniteScroll(
    "exploreV2SpeciesCounts",
    fetchSpeciesCounts,
    {
      ...params,
      per_page: byTaxonomy
        ? TAXONOMIC_PAGE_SIZE
        : SPECIES_PAGE_SIZE,
      ...( !currentUser && { locale } ),
      fields: {
        taxon: Taxon.LIMITED_TAXON_FIELDS,
      },
    },
    { enabled, persist: true },
  );

  const speciesCounts = data as SpeciesCountResult[];

  useFetchPagesUpTo( {
    enabled: byTaxonomy && enabled,
    loadedCount: speciesCounts.length,
    limit: EXPLORE_TAXONOMIC_SPECIES_LIMIT,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } );
  const taxonomicLoadDone = !hasNextPage
    || speciesCounts.length >= EXPLORE_TAXONOMIC_SPECIES_LIMIT;
  const speciesTaxa = useMemo( ( ) => ( byTaxonomy
    ? speciesCounts.map( item => ( {
      key: speciesKey( item ),
      taxon: { ...item.taxon, id: item.taxon.id as number },
    } ) )
    : [] ), [byTaxonomy, speciesCounts] );
  const lineages = useLineages( speciesTaxa, byTaxonomy, taxonomicLoadDone );
  const listData = useMemo( ( ) => ( byTaxonomy
    ? sortByTaxonomyWithKey(
      speciesCounts.slice( 0, EXPLORE_TAXONOMIC_SPECIES_LIMIT ),
      lineages,
      speciesKey,
    )
    : speciesCounts ), [byTaxonomy, speciesCounts, lineages] );

  const taxonIds = speciesCounts.map( r => r.taxon.id as number );

  // taxonIdChunks holds the cumulative list of all taxa viewed, sliced into groups of 10
  // (one per page), or bigger ones for taxonomic order's big pages
  const seenChunkSize = byTaxonomy
    ? TAXONOMIC_SEEN_CHUNK_SIZE
    : SPECIES_PAGE_SIZE;
  const taxonIdChunks: number[][] = [];
  for ( let i = 0; i < taxonIds.length; i += seenChunkSize ) {
    taxonIdChunks.push( taxonIds.slice( i, i + seenChunkSize ) );
  }

  // useQueries executes taxonIdChunks.length queries,
  // relying on React Query's caching so each full chunk actually runs only once
  // TODO split out a shared useQueries wrapper if multiple use sites become necessary
  const observedIds = useQueries( {
    queries: taxonIdChunks.map( chunk => ( {
      queryKey: ["exploreV2SpeciesCountsSeen", currentUser?.id, chunk],
      queryFn: ( ) => fetchSpeciesCounts<ApiSpeciesCountSummary>( {
        user_id: currentUser?.id,
        taxon_id: chunk,
        per_page: chunk.length,
        fields: SPECIES_COUNTS_SUMMARY_FIELDS,
      } ),
      enabled: !!( currentUser && chunk.length > 0 ),
      // we don't really need to worry about a user's life list changing on this screen
      staleTime: Infinity,
      retry: ( failureCount: number, error: unknown ) => reactQueryRetry(
        failureCount,
        error,
        { queryKey: ["exploreV2SpeciesCountsSeen"] },
      ),
      retryDelay: ( failureCount: number, error: unknown ) => handleRetryDelay(
        failureCount,
        error,
      ),
    } ) ),
    combine: results => {
      const ids: number[] = [];
      results.forEach( r => {
        const seen = ( r.data as { results?: SpeciesCountResult[] } | undefined )?.results;
        seen?.forEach( x => ids.push( x.taxon.id as number ) );
      } );
      // Return a sorted array so React Query's replaceEqualDeep reuses the previous
      // reference when the observed set is unchanged
      return ids.sort( ( a, b ) => a - b );
    },
  } );

  // observedIds is a stable, sorted reference,
  // so this Set is only rebuilt when the observed set actually changes.
  // observedIdSet.has is O(1) where observedIds.includes would be O(n)
  // sort of overkill but I think it's nice
  const observedIdSet = useMemo( ( ) => new Set( observedIds ), [observedIds] );

  const renderItem = useCallback(
    // eslint-plugin-react mistakes this render callback for a component and
    // flags its param type as unused prop types
    // eslint-disable-next-line react/no-unused-prop-types
    ( { item }: { item: SpeciesCountResult } ) => (
      <ExploreV2SpeciesGridItem
        // Unique key ensures component recreation so images don't get
        // recycled and show on the wrong taxon
        key={`taxon-${item.taxon.id}-${item.taxon.default_photo?.url}`}
        count={item.count}
        showSpeciesSeenCheckmark={observedIdSet.has( item.taxon.id )}
        style={gridItemStyle}
        taxon={item.taxon}
      />
    ),
    [gridItemStyle, observedIdSet],
  );

  const list = (
    <ExploreFlashList
      canFetch={enabled}
      contentContainerStyle={flashListStyle}
      data={listData}
      // Taxonomic order loads everything it sorts itself, and more would land all over the list
      fetchNextPage={byTaxonomy
        ? undefined
        : fetchNextPage}
      hideLoadingWheel={!isFetchingNextPage}
      isFetchingNextPage={isFetchingNextPage}
      isConnected={isConnected}
      keyExtractor={( item: SpeciesCountResult ) => (
        `${item.taxon.id}-${item.taxon.default_photo?.url || "no-photo"}`
      )}
      layout="grid"
      numColumns={numColumns}
      renderItem={renderItem}
      scrollRestoreKey={scrollRestoreKey}
      totalResults={totalResults}
      testID="ExploreV2SpeciesList"
    />
  );

  if ( !byTaxonomy ) return list;
  return (
    <View className="flex-1">
      <TaxonomicOrderNotice
        kind="species"
        loaded={speciesCounts.length}
        limit={EXPLORE_TAXONOMIC_SPECIES_LIMIT}
        total={totalResults}
      />
      {list}
    </View>
  );
};

export default ExploreV2SpeciesView;
