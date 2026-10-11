import type { Lifer } from "components/LifeList/LifeListContainer";
import { LiferGridItem } from "components/LifeList/LifeListContainer";
import React, { useEffect, useMemo, useState } from "react";
import type { ListRenderItemInfo } from "react-native";
import { useAuthenticatedQuery, useGridLayout } from "sharedHooks";

import ExploreFlashList from "./ExploreFlashList";
import { lifeListCacheKey, readCachedLifeList, syncLifeList } from "./lifeListCache";

interface Props {
  canFetch?: boolean;
  isConnected: boolean;
  queryParams: Record<string, unknown>;
  handleUpdateCount: ( view: string, count: number ) => void;
}

// Every matching observation, grouped by species and keeping the earliest, so
// each species appears once with the date it was first observed. Newest first,
// like My Lifers, and cached locally and synced incrementally the same way.
const LifeListView = ( {
  canFetch,
  isConnected,
  queryParams,
  handleUpdateCount,
}: Props ) => {
  const { flashListStyle, gridItemStyle, numColumns } = useGridLayout( );
  const cacheKey = lifeListCacheKey( queryParams );
  // What a first sync has found so far, so it doesn't sit on a spinner.
  const [progress, setProgress] = useState<{ key: string; lifers: Lifer[] } | null>( null );

  const { data, isFetching } = useAuthenticatedQuery(
    ["exploreLifeList", cacheKey],
    optsWithAuth => syncLifeList( queryParams, optsWithAuth, lifers => {
      setProgress( { key: cacheKey, lifers } );
    } ),
    {
      enabled: !!canFetch,
      initialData: ( ) => {
        const cached = readCachedLifeList( cacheKey );
        return cached.length
          ? cached
          : undefined;
      },
    },
  );

  const lifers = useMemo( ( ) => {
    const partial = isFetching && progress?.key === cacheKey
      ? progress.lifers
      : [];
    if ( partial.length > ( data?.length ?? 0 ) ) {
      return partial;
    }
    return data ?? [];
  }, [cacheKey, data, isFetching, progress] );

  useEffect( ( ) => {
    if ( !isFetching || lifers.length > 0 ) handleUpdateCount( "lifelist", lifers.length );
  }, [handleUpdateCount, isFetching, lifers.length] );

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
      hideLoadingWheel={!isFetching}
      isFetchingNextPage={isFetching}
      isConnected={isConnected}
      keyExtractor={( item: Lifer ) => item.uuid}
      layout="grid"
      numColumns={numColumns}
      renderItem={( { item }: ListRenderItemInfo<Lifer> ) => (
        <LiferGridItem item={item} style={gridItemStyle} />
      )}
      totalResults={isFetching && lifers.length === 0
        ? null
        : lifers.length}
      testID="ExploreLifeListAnimatedList"
    />
  );
};

export default LifeListView;
