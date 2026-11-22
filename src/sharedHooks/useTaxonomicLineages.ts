import { fetchTaxaBasics } from "api/taxa";
import { RealmContext } from "providers/contexts";
import { useEffect, useMemo, useState } from "react";
import type { RealmObservation, RealmTaxon } from "realmModels/types";
import { loadTaxonomyCache } from "sharedHelpers/offlineTaxonomy";
import type { LineageStep } from "sharedHelpers/taxonomicSort";
import { taxonLineageIds } from "sharedHelpers/taxonomicSort";
import useNonAuthenticatedQuery from "sharedHooks/useQuery";

const { useQuery, useRealm } = RealmContext;

// The most ids the API's /taxa/:ids takes in one request
const TAXA_PER_REQUEST = 30;

type OfflineTaxonomy = Awaited<ReturnType<typeof loadTaxonomyCache>>;

const NO_OFFLINE_TAXONOMY: OfflineTaxonomy = new Map( );

// The on-device model's taxonomy file, which names most ancestors without a request. Empty when
// there's no model file
const useOfflineTaxonomy = ( enabled: boolean ): OfflineTaxonomy | null => {
  const [taxonomy, setTaxonomy] = useState<OfflineTaxonomy | null>( null );
  useEffect( ( ) => {
    if ( !enabled || taxonomy ) return;
    let cancelled = false;
    loadTaxonomyCache( )
      .catch( ( ) => NO_OFFLINE_TAXONOMY )
      .then( loaded => { if ( !cancelled ) setTaxonomy( loaded ); } );
    // eslint-disable-next-line consistent-return
    return ( ) => { cancelled = true; };
  }, [enabled, taxonomy] );
  return taxonomy;
};

const fetchNames = async ( ids: number[] ): Promise<Map<number, string>> => {
  const chunks: number[][] = [];
  for ( let i = 0; i < ids.length; i += TAXA_PER_REQUEST ) {
    chunks.push( ids.slice( i, i + TAXA_PER_REQUEST ) );
  }
  const results: { id: number; name: string }[][] = await Promise.all( chunks.map(
    chunk => fetchTaxaBasics( chunk, {}, { fields: { id: true, name: true } } ),
  ) );
  return new Map( results.flat( ).filter( Boolean ).map( taxon => [taxon.id, taxon.name] ) );
};

export interface KeyedTaxon {
  key: string;
  taxon: {
    id: number;
    name?: string | null;
    ancestor_ids?: ArrayLike<number> | null;
  };
}

// Index of key → the lineage of names of each taxon, for sorting taxonomically. Names come from
// the taxa themselves, Realm and the model's taxonomy file first; whatever none has is fetched
// from the API (only once fetchMissing is true, so a list still loading page by page doesn't
// refetch them for every page), and sorts by id until it arrives (or for good, offline).
export const useLineages = (
  taxa: KeyedTaxon[],
  enabled: boolean,
  fetchMissing = true,
): Map<string, LineageStep[]> => {
  const realm = useRealm( );
  const offlineTaxonomy = useOfflineTaxonomy( enabled );

  const { lineageIds, localNames, missingIds } = useMemo( ( ) => {
    const idsByKey = new Map<string, number[]>( );
    const names = new Map<number, string>( );
    taxa.forEach( ( { key, taxon } ) => {
      idsByKey.set( key, taxonLineageIds( taxon ) );
      if ( taxon.name ) names.set( taxon.id, taxon.name );
    } );
    const missing: number[] = [];
    new Set( [...idsByKey.values( )].flat( ) ).forEach( id => {
      if ( names.has( id ) ) return;
      const name = offlineTaxonomy?.get( id )?.name
        || realm.objectForPrimaryKey<RealmTaxon>( "Taxon", id )?.name;
      if ( name ) {
        names.set( id, name );
      } else {
        missing.push( id );
      }
    } );
    return {
      lineageIds: idsByKey,
      localNames: names,
      // Wait for the taxonomy file so we don't request names it would have had
      missingIds: offlineTaxonomy
        ? missing.sort( ( a, b ) => a - b )
        : [],
    };
  }, [taxa, offlineTaxonomy, realm] );

  const { data: remoteNames } = useNonAuthenticatedQuery(
    ["fetchTaxaNames", missingIds.join( "," )],
    ( ) => fetchNames( missingIds ),
    {
      enabled: enabled && fetchMissing && missingIds.length > 0,
      staleTime: Infinity,
    },
  );

  return useMemo( ( ) => {
    const names = remoteNames
      ? new Map( [...remoteNames, ...localNames] )
      : localNames;
    const lineages = new Map<string, LineageStep[]>( );
    lineageIds.forEach( ( ids, key ) => {
      lineages.set( key, ids.map( id => ( { id, name: names.get( id ) } ) ) );
    } );
    return lineages;
  }, [lineageIds, localNames, remoteNames] );
};

// Index of uuid → the lineage of names of the user's local observations' taxa
const useTaxonomicLineages = ( enabled: boolean ): Map<string, LineageStep[]> => {
  const observations = useQuery<RealmObservation>(
    {
      type: "Observation",
      query: obs => obs.filtered( enabled
        ? "taxon != nil"
        : "FALSEPREDICATE" ),
      keyPaths: ["uuid", "taxon.id", "taxon.name", "taxon.ancestor_ids"],
    },
    [enabled],
  );
  const taxa = useMemo( ( ) => {
    const keyed: KeyedTaxon[] = [];
    observations.forEach( ( { uuid, taxon } ) => {
      if ( taxon ) keyed.push( { key: uuid, taxon } );
    } );
    return keyed;
  }, [observations] );
  return useLineages( taxa, enabled );
};

export default useTaxonomicLineages;
