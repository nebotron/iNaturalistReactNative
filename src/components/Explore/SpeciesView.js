// @flow

import { fetchSpeciesCounts } from "api/observations";
import ExploreTaxonGridItem from "components/Explore/ExploreTaxonGridItem";
import i18n from "i18next";
import {
  useExplore,
} from "providers/ExploreContext";
import type { Node } from "react";
import React, {
  useEffect, useMemo, useRef, useState,
} from "react";
import Taxon from "realmModels/Taxon";
import {
  useCurrentUser,
  useGridLayout,
  useInfiniteScroll,
  useQuery,
} from "sharedHooks";

import ExploreFlashList from "./ExploreFlashList";

type Props = {
  canFetch?: boolean,
  isConnected: boolean,
  queryParams: Object,
  handleUpdateCount: Function
}

const SpeciesView = ( {
  canFetch,
  isConnected,
  queryParams,
  handleUpdateCount,
}: Props ): Node => {
  // Prevents flickering when a user scrolls and new species are loaded on screen
  const [observedTaxonIds, setObservedTaxonIds] = useState( new Set( ) );
  // Tracks which taxon IDs have already been sent to the seen-status query so we only
  // request new IDs on each page load rather than re-fetching all accumulated IDs.
  const queriedTaxonIdsRef = useRef( new Set( ) );
  const [pendingTaxonIds, setPendingTaxonIds] = useState( [] );
  const currentUser = useCurrentUser( );
  const { state } = useExplore();
  const { excludeUser, unobservedByMe } = state;
  const {
    flashListStyle,
    gridItemStyle,
    numColumns,
  } = useGridLayout( );

  // query all of current users seen species if "not by me" explore filter
  const { data: seenByCurrentUserAll } = useQuery(
    ["fetchSpeciesCountsAll"],
    ( ) => fetchSpeciesCounts( {
      user_id: currentUser?.id,
      ttl: -1,
      fields: {
        taxon: {
          id: true,
        },
      },
    } ),
    {
      enabled: ( !!currentUser && !!excludeUser ),
    },
  );

  const pageObservedTaxonIdsAll = useMemo( ( ) => seenByCurrentUserAll?.results?.map(
    r => r.taxon.id,
  ) || [], [seenByCurrentUserAll?.results] );

  // The API's unobserved_by_user_id filter only excludes taxa the user has
  // observed at that exact rank, so a subspecies whose parent species the user
  // has already observed still shows up as "unobserved". Fetch the user's
  // observed species and additionally exclude them via without_taxon_id, which
  // (unlike unobserved_by_user_id) also excludes their descendants.
  const { data: seenSpeciesByCurrentUser } = useQuery(
    ["fetchSpeciesCountsSeenSpecies"],
    ( ) => fetchSpeciesCounts( {
      user_id: currentUser?.id,
      ttl: -1,
      fields: {
        taxon: {
          id: true,
          rank_level: true,
        },
      },
    } ),
    {
      enabled: ( !!currentUser && !!unobservedByMe ),
    },
  );

  const observedSpeciesIds = useMemo( ( ) => seenSpeciesByCurrentUser?.results
    ?.filter( r => r.taxon.rank_level === Taxon.SPECIES_LEVEL )
    ?.map( r => r.taxon.id ) || [], [seenSpeciesByCurrentUser?.results] );

  let params = queryParams;
  if ( excludeUser ) {
    params = { ...queryParams, without_taxon_id: pageObservedTaxonIdsAll };
  } else if ( unobservedByMe ) {
    params = { ...queryParams, without_taxon_id: observedSpeciesIds };
  }

  const locale = i18n?.language ?? "en";

  const {
    data,
    isFetchingNextPage,
    fetchNextPage,
    totalResults,
  } = useInfiniteScroll(
    "fetchSpeciesCounts",
    fetchSpeciesCounts,
    {
      ...params,
      ...( !currentUser && { locale } ),
      fields: {
        taxon: Taxon.LIMITED_TAXON_FIELDS,
      },
    },
    {
      enabled: canFetch,
    },
  );

  const taxonIds = data.map( r => r.taxon.id );

  // Reset per-session seen-status cache when the user changes (login/logout).
  useEffect( ( ) => {
    queriedTaxonIdsRef.current = new Set( );
    setObservedTaxonIds( new Set( ) );
    setPendingTaxonIds( [] );
  }, [currentUser?.id] );

  // Only enqueue taxon IDs that haven't been checked yet so each page load sends
  // exactly one small request instead of re-fetching all accumulated IDs.
  useEffect( ( ) => {
    if ( !currentUser ) return;
    const newIds = taxonIds.filter( id => !queriedTaxonIdsRef.current.has( id ) );
    if ( newIds.length === 0 ) return;
    newIds.forEach( id => queriedTaxonIdsRef.current.add( id ) );
    setPendingTaxonIds( newIds );
  }, [taxonIds, currentUser] );

  const { data: seenByCurrentUser } = useQuery(
    ["fetchSpeciesSeenStatus", pendingTaxonIds],
    ( ) => fetchSpeciesCounts( {
      user_id: currentUser?.id,
      taxon_id: pendingTaxonIds,
      fields: {
        taxon: {
          id: true,
        },
      },
    } ),
    {
      enabled: !!( pendingTaxonIds.length > 0 && currentUser ),
    },
  );

  const pageObservedTaxonIds = useMemo( ( ) => seenByCurrentUser?.results?.map(
    r => r.taxon.id,
  ) || [], [seenByCurrentUser?.results] );

  useEffect( ( ) => {
    if ( pageObservedTaxonIds.length > 0 ) {
      setObservedTaxonIds( prev => {
        const next = new Set( prev );
        pageObservedTaxonIds.forEach( id => next.add( id ) );
        return next;
      } );
    }
  }, [pageObservedTaxonIds] );

  const renderItem = ( { item } ) => {
    const taxon = item?.taxon;
    const taxonId = taxon.id;
    // Add a unique key to ensure component recreation
    // so images don't get recycled and show on the wrong taxon
    const itemKey = `taxon-${taxonId}-${taxon?.default_photo?.url}`;

    return (
      <ExploreTaxonGridItem
        key={itemKey}
        count={item?.count}
        style={gridItemStyle}
        taxon={taxon}
        showSpeciesSeenCheckmark={observedTaxonIds.has( taxonId )}
      />
    );
  };

  useEffect( ( ) => {
    handleUpdateCount( "species", totalResults );
  }, [handleUpdateCount, totalResults] );

  const contentContainerStyle = useMemo( ( ) => ( {
    ...flashListStyle,
    paddingTop: 50,
  } ), [flashListStyle] );

  return (
    <ExploreFlashList
      canFetch={canFetch}
      contentContainerStyle={contentContainerStyle}
      data={data}
      fetchNextPage={fetchNextPage}
      hideLoadingWheel={!isFetchingNextPage}
      isFetchingNextPage={isFetchingNextPage}
      isConnected={isConnected}
      keyExtractor={item => `${item.taxon.id}-${item?.taxon?.default_photo?.url || "no-photo"}`}
      layout="grid"
      numColumns={numColumns}
      renderItem={renderItem}
      totalResults={totalResults}
      testID="ExploreSpeciesAnimatedList"
    />
  );
};

export default SpeciesView;
