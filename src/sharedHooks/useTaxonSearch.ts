import { useNetInfo } from "@react-native-community/netinfo";
import { searchTaxa } from "api/taxa";
import type { ApiTaxon } from "api/types";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import { RealmContext } from "providers/contexts";
import {
  useCallback, useEffect, useMemo, useState,
} from "react";
import { UpdateMode } from "realm";
import Taxon from "realmModels/Taxon";
import type { RealmTaxon } from "realmModels/types";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import validateRealmSearch from "sharedHelpers/validateRealmSearch";
import { useIconicTaxa } from "sharedHooks";

const { useRealm } = RealmContext;

const ONLINE_SEARCH_DEBOUNCE_MS = 250;

const useTaxonSearch = ( taxonQueryArg = "" ) => {
  const realm = useRealm( );
  const iconicTaxa = useIconicTaxa( { reload: false } );
  const taxonQuery = taxonQueryArg.trim();
  const [localTaxa, setLocalTaxa] = useState<RealmTaxon[] | null>( null );
  const [isUpdatingLocalDb, setIsUpdatingLocalDb] = useState( false );
  // Online results, keyed by the query they answer so stale ones are ignored
  const [remoteResult, setRemoteResult] = useState<{
    query: string;
    taxa: RealmTaxon[];
  } | null>( null );
  const { isConnected } = useNetInfo( );

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
      const exact: RealmTaxon[] = [];
      const partial: RealmTaxon[] = [];
      const allTaxa = realm.objects( "Taxon" );
      // Keep scanning past the partial-match cap so an exact match (e.g. a
      // bird code) cached late in the collection is never missed.
      for ( let i = 0; i < allTaxa.length; i += 1 ) {
        const taxon = allTaxa[i];
        const searchableName = Taxon.compileSearchableName( taxon ).toLowerCase( );
        if ( searchableName.includes( lowerQuery ) ) {
          if ( searchableName.split( ";" ).includes( lowerQuery ) ) {
            exact.push( taxon );
          } else if ( partial.length < 50 ) {
            partial.push( taxon );
          }
        }
      }
      // Exact name matches (scientific name, common name, or bird code equal
      // to the query) appear before partial/substring matches, with a bird
      // code match first of all.
      const code = lowerQuery.toUpperCase( );
      exact.sort( ( a, b ) => Number( Taxon.abaCode( b ) === code )
        - Number( Taxon.abaCode( a ) === code ) );
      return [...exact, ...partial];
    } catch ( error ) {
      throw new Error( `Search failed: ${error.message}` );
    }
  }, [realm] );

  // When online, fetch taxa matching the query from the API and save them to
  // Realm, so they show up now and in future offline searches. Local results
  // are shown until the online results arrive.
  useEffect( ( ) => {
    if ( taxonQuery.length === 0 || !isConnected ) return ( ) => undefined;
    let isSubscribed = true;
    const timer = setTimeout( async ( ) => {
      setIsUpdatingLocalDb( true );
      try {
        const apiToken = await getJWT( );
        const remoteTaxa = await searchTaxa( { q: taxonQuery }, { api_token: apiToken } );
        if ( !isSubscribed || !remoteTaxa || remoteTaxa.length === 0 ) return;
        const mappedTaxa = remoteTaxa.map(
          ( remoteTaxon: ApiTaxon ) => Taxon.mapApiToRealm( remoteTaxon, realm ),
        );
        safeRealmWrite( realm, ( ) => {
          mappedTaxa.forEach( mappedTaxon => {
            realm.create( "Taxon", Taxon.forUpdate( mappedTaxon ), UpdateMode.Modified );
          } );
        }, "updating local species db from search" );
        const taxa = mappedTaxa
          .map( mappedTaxon => realm.objectForPrimaryKey<RealmTaxon>( "Taxon", mappedTaxon.id ) )
          .filter( ( taxon ): taxon is RealmTaxon => !!taxon );
        if ( isSubscribed ) setRemoteResult( { query: taxonQuery, taxa } );
      } catch ( error ) {
        console.error( "Online taxon search failed:", error );
      } finally {
        if ( isSubscribed ) setIsUpdatingLocalDb( false );
      }
    }, ONLINE_SEARCH_DEBOUNCE_MS );
    return ( ) => {
      isSubscribed = false;
      clearTimeout( timer );
      setIsUpdatingLocalDb( false );
    };
  }, [taxonQuery, isConnected, realm] );

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

  const searchResult = useMemo( () => {
    // Show iconic taxa by default (empty query)
    if ( taxonQuery.length === 0 ) {
      return {
        taxa: iconicTaxa,
        refetch: () => undefined,
        isLoading: false,
      };
    }

    // Show local results until online results arrive, then replace them
    const unorderedTaxa = remoteResult?.query === taxonQuery
      ? remoteResult.taxa
      : localTaxa || [];
    // An exact 4-letter bird code match always comes first, even when the
    // API ranks it lower or omits it.
    const code = taxonQuery.replace( /[^a-zA-Z]/g, "" ).toUpperCase( );
    const codeMatches = new Map( ( localTaxa || [] ).concat( unorderedTaxa )
      .filter( taxon => Taxon.abaCode( taxon ) === code )
      .map( taxon => [taxon.id, taxon] ) );
    const taxa = [
      ...codeMatches.values( ),
      ...unorderedTaxa.filter( taxon => !codeMatches.has( taxon.id ) ),
    ];
    if ( taxa.length > 0 ) {
      return {
        taxa,
        refetch: () => undefined,
        isLoading: false,
      };
    }

    // No results (loading or empty)
    return {
      taxa: [],
      refetch: () => undefined,
      isLoading: isUpdatingLocalDb,
    };
  }, [taxonQuery, localTaxa, remoteResult, iconicTaxa, isUpdatingLocalDb] );

  return searchResult;
};

export default useTaxonSearch;
