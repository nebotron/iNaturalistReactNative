import { RealmContext } from "providers/contexts";
import {
  useCallback, useEffect, useMemo, useState,
} from "react";
import Taxon from "realmModels/Taxon";
import type { RealmTaxon } from "realmModels/types";
import validateRealmSearch from "sharedHelpers/validateRealmSearch";
import { useIconicTaxa } from "sharedHooks";

const { useRealm } = RealmContext;

const useTaxonSearch = ( taxonQueryArg = "" ) => {
  const realm = useRealm( );
  const iconicTaxa = useIconicTaxa( { reload: false } );
  const taxonQuery = taxonQueryArg.trim();
  const [localTaxa, setLocalTaxa] = useState<RealmTaxon[] | null>( null );

  // Do the substring match in JS rather than via Realm's query language.
  // Realm's CONTAINS operator on this property was unreliable in
  // practice (results that plainly contained the substring, e.g.
  // "Brown-headed Cowbird" for a query of "brownheaded", did not come
  // back), so we fetch the cached taxa and match manually to guarantee
  // correct, hyphen/whitespace-agnostic substring matching offline.
  //
  // We normalize each taxon's name on the fly instead of reading the
  // stored _searchableName, because that field is null for taxa written
  // through the observation-save path (Observation.mapApiToRealm ->
  // Taxon.mapApiToRealm never calls compileSearchableName) and may be
  // stale on taxa cached before the current normalization. Recomputing
  // guarantees every cached taxon matches all hyphen/space variants.
  const safeRealmSearch = useCallback( async ( searchString: string ) => {
    try {
      const { cleanedQuery } = validateRealmSearch( searchString );
      const lowerQuery = cleanedQuery.toLowerCase();
      const matches: RealmTaxon[] = [];
      const allTaxa = realm.objects( "Taxon" );
      for ( let i = 0; i < allTaxa.length && matches.length < 50; i += 1 ) {
        const taxon = allTaxa[i];
        const searchableName = Taxon.compileSearchableName( taxon ).toLowerCase( );
        if ( searchableName.includes( lowerQuery ) ) {
          matches.push( taxon );
        }
      }
      return matches;
    } catch ( error ) {
      throw new Error( `Search failed: ${error.message}` );
    }
  }, [realm] );

  useEffect( ( ) => {
    let isSubscribed = true;
    const searchLocalTaxa = async ( ) => {
      if ( taxonQuery.length === 0 ) {
        if ( isSubscribed ) setLocalTaxa( null );
        return;
      }

      try {
        const results = await safeRealmSearch( taxonQuery );
        if ( isSubscribed ) setLocalTaxa( results );
      } catch ( error ) {
        console.error( "Local search failed:", error );
        if ( isSubscribed ) setLocalTaxa( [] );
      }
    };

    searchLocalTaxa( );

    return ( ) => {
      isSubscribed = false;
    };
  }, [
    realm,
    safeRealmSearch,
    taxonQuery,
  ] );

  return useMemo( () => {
    // Show iconic taxa by default (empty query)
    if ( taxonQuery.length === 0 ) {
      return {
        taxa: iconicTaxa,
        refetch: () => undefined,
        isLoading: false,
      };
    }

    // Show local taxa from offline search
    if ( localTaxa !== null && localTaxa.length > 0 ) {
      return {
        taxa: localTaxa,
        refetch: () => undefined,
        isLoading: false,
      };
    }

    // No results (loading or empty)
    return {
      taxa: [],
      refetch: () => undefined,
      isLoading: false,
    };
  }, [taxonQuery, localTaxa, iconicTaxa] );
};

export default useTaxonSearch;
