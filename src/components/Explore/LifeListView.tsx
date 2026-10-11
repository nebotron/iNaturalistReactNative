import { searchObservations } from "api/observations";
import type { ApiObservation } from "api/types";
import type { Lifer } from "components/LifeList/LifeListContainer";
import { LiferGridItem, toLifer } from "components/LifeList/LifeListContainer";
import React, { useEffect, useMemo } from "react";
import type { ListRenderItemInfo } from "react-native";
import { OBSERVATION_SYNC_FIELDS } from "sharedHelpers/userObservationsCache";
import { useGridLayout, useInfiniteScroll } from "sharedHooks";

import ExploreFlashList from "./ExploreFlashList";

const PER_PAGE = 200;
// The API won't page past 10,000 results.
const MAX_RESULTS = 10000;

interface Props {
  canFetch?: boolean;
  isConnected: boolean;
  queryParams: object;
  handleUpdateCount: ( view: string, count: number ) => void;
}

// Every matching observation, grouped by species and keeping the earliest, so
// each species appears once with the date it was first observed. Newest first,
// like My Lifers.
const LifeListView = ( {
  canFetch,
  isConnected,
  queryParams,
  handleUpdateCount,
}: Props ) => {
  const { flashListStyle, gridItemStyle, numColumns } = useGridLayout( );

  const {
    data, isFetching, fetchNextPage, totalResults,
  } = useInfiniteScroll(
    "lifeListObservations",
    searchObservations,
    {
      ...queryParams,
      order_by: "observed_on",
      order: "asc",
      per_page: PER_PAGE,
      fields: OBSERVATION_SYNC_FIELDS,
    },
    { enabled: canFetch },
  );

  // Grouping needs every observation, so page through them without waiting
  // for the user to scroll.
  const hasMore = totalResults !== null
    && data.length < Math.min( totalResults, MAX_RESULTS );
  useEffect( ( ) => {
    if ( hasMore && !isFetching ) fetchNextPage( );
  }, [hasMore, isFetching, fetchNextPage] );

  const lifers = useMemo( ( ) => {
    const earliest = new Map<number, Lifer>( );
    data.forEach( ( obs: ApiObservation ) => {
      const lifer = toLifer( obs );
      if ( !lifer?.speciesId ) return;
      const existing = earliest.get( lifer.speciesId );
      const isEarlier = !!lifer.observed_on
        && ( !existing?.observed_on || lifer.observed_on < existing.observed_on );
      if ( !existing || isEarlier ) {
        earliest.set( lifer.speciesId, lifer );
      }
    } );
    return Array.from( earliest.values( ) ).sort(
      ( a, b ) => ( b.observed_on ?? "" ).localeCompare( a.observed_on ?? "" ),
    );
  }, [data] );

  useEffect( ( ) => {
    if ( totalResults !== null ) handleUpdateCount( "lifelist", lifers.length );
  }, [handleUpdateCount, lifers.length, totalResults] );

  const contentContainerStyle = useMemo( ( ) => ( {
    ...flashListStyle,
    paddingTop: 50,
  } ), [flashListStyle] );

  return (
    <ExploreFlashList
      canFetch={canFetch}
      contentContainerStyle={contentContainerStyle}
      data={lifers}
      fetchNextPage={( ) => undefined}
      hideLoadingWheel={!hasMore}
      isFetchingNextPage={hasMore}
      isConnected={isConnected}
      keyExtractor={( item: Lifer ) => item.uuid}
      layout="grid"
      numColumns={numColumns}
      renderItem={( { item }: ListRenderItemInfo<Lifer> ) => (
        <LiferGridItem item={item} style={gridItemStyle} />
      )}
      totalResults={totalResults === null
        ? null
        : lifers.length}
      testID="ExploreLifeListAnimatedList"
    />
  );
};

export default LifeListView;
