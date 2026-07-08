import { useNavigation, useRoute } from "@react-navigation/native";
import {
  ActivityIndicator,
  Body1,
  Body2,
  Button,
} from "components/SharedComponents";
import BackButton from "components/SharedComponents/Buttons/BackButton";
import { SharedStackViewWrapper } from "components/SharedComponents/ViewWrapper";
import { Pressable, ScrollView, View } from "components/styledComponents";
import type { NoBottomTabStackScreenProps, TabStackScreenProps } from "navigation/types";
import React, { useCallback, useEffect, useState } from "react";
import {
  computeLookalikesFromObs,
  FETCH_MORE_OBS_COUNT,
  getCachedLookalikes,
  INATURALIST_API,
  type LookalikeEntry,
  LOOKALIKE_PAGE_SIZE,
  LOOKALIKE_RADIUS_KM,
  setCachedLookalikes,
} from "sharedHelpers/speciesGameLookalikes";

interface RouteParams {
  taxonId: number;
  targetLabel: string;
  lookalikeLabel: string;
}

const SpeciesGameWhySpecies = ( ) => {
  const navigation = useNavigation<
    NoBottomTabStackScreenProps<"SpeciesGameWhySpecies">["navigation"] &
    TabStackScreenProps<"SpeciesGameWhySpecies">["navigation"]
  >( );
  const { params } = useRoute( );
  const { taxonId, targetLabel, lookalikeLabel } = params as RouteParams;

  const [lookalikesData, setLookalikesData] = useState<LookalikeEntry[]>( [] );
  const [usedMisidentifications, setUsedMisidentifications] = useState( false );
  const [obsScannedCount, setObsScannedCount] = useState( 0 );
  const [isFetchingMoreObs, setIsFetchingMoreObs] = useState( false );
  const [isLoading, setIsLoading] = useState( true );

  const fetchTaxonInfo = useCallback( async ( id: number ) => {
    const res = await fetch(
      `${INATURALIST_API}/taxa/${id}`
        + "?fields=preferred_common_name,name,rank_level",
    );
    if ( !res.ok ) return null;
    const data = await res.json( );
    const t = data.results?.[0];
    if ( !t ) return null;
    return {
      id,
      name: t.name as string,
      preferredCommonName: t.preferred_common_name as string | undefined,
    };
  }, [] );

  useEffect( ( ) => {
    let cancelled = false;
    const load = async ( ) => {
      const cached = getCachedLookalikes( taxonId );
      if ( !cached || cached.entries.length === 0 ) {
        if ( !cancelled ) setIsLoading( false );
        return;
      }
      setObsScannedCount( cached.obsScanned );
      setUsedMisidentifications( true );

      const withNames = await Promise.all(
        cached.entries.slice( 0, 10 ).map( async entry => {
          const info = await fetchTaxonInfo( entry.taxonId );
          return {
            taxonId: entry.taxonId,
            count: entry.count,
            observationUuids: entry.observationUuids,
            name: info?.name ?? String( entry.taxonId ),
            commonName: info?.preferredCommonName,
          };
        } ),
      );
      if ( !cancelled ) {
        setLookalikesData( withNames );
        setIsLoading( false );
      }
    };
    load( ).catch( ( ) => { if ( !cancelled ) setIsLoading( false ); } );
    return ( ) => { cancelled = true; };
  }, [taxonId, fetchTaxonInfo] );

  const handleFetchMoreObservations = useCallback( async ( ) => {
    setIsFetchingMoreObs( true );
    try {
      const cached = getCachedLookalikes( taxonId );
      const baseObsScanned = cached?.obsScanned ?? obsScannedCount;
      const seedEntries = cached?.entries ?? [];

      const baseUrl = `${INATURALIST_API}/observations`
        + `?taxon_id=${taxonId}&per_page=${LOOKALIKE_PAGE_SIZE}&order_by=random`;
      const startPage = Math.floor( baseObsScanned / LOOKALIKE_PAGE_SIZE ) + 1;
      const pageCount = FETCH_MORE_OBS_COUNT / LOOKALIKE_PAGE_SIZE;
      const pages = Array.from( { length: pageCount }, ( _, i ) => startPage + i );

      const responses = await Promise.all( pages.map( p => fetch( `${baseUrl}&page=${p}` ) ) );
      const newResults: unknown[] = [];
      for ( const res of responses ) {
        if ( res.ok ) {
          // eslint-disable-next-line no-await-in-loop
          const d = await res.json( );
          newResults.push( ...( d.results ?? [] ) );
        }
      }

      const merged = computeLookalikesFromObs( newResults, taxonId, seedEntries );
      const newObsScanned = baseObsScanned + newResults.length;
      setCachedLookalikes( taxonId, {
        entries: merged.entries,
        topId: merged.topId,
        obsScanned: newObsScanned,
      } );
      setObsScannedCount( newObsScanned );
      setUsedMisidentifications( merged.entries.length > 0 );

      const knownNames = new Map(
        lookalikesData.map( e => [e.taxonId, { name: e.name, commonName: e.commonName }] ),
      );
      const withNames = await Promise.all(
        merged.entries.slice( 0, 10 ).map( async entry => {
          const known = knownNames.get( entry.taxonId );
          if ( known ) return { ...entry, ...known };
          const info = await fetchTaxonInfo( entry.taxonId );
          return {
            taxonId: entry.taxonId,
            count: entry.count,
            observationUuids: entry.observationUuids,
            name: info?.name ?? String( entry.taxonId ),
            commonName: info?.preferredCommonName,
          };
        } ),
      );
      setLookalikesData( withNames );
    } finally {
      setIsFetchingMoreObs( false );
    }
  }, [taxonId, obsScannedCount, lookalikesData, fetchTaxonInfo] );

  return (
    <SharedStackViewWrapper>
      <View className="flex-row items-center px-3 py-2 bg-white border-b border-lightGray">
        <BackButton inCustomHeader />
        {/* eslint-disable-next-line i18next/no-literal-string */}
        <Body1 className="font-bold ml-2">Why these species?</Body1>
      </View>

      <ScrollView className="flex-1 px-4 pt-4">
        {isLoading
          ? <ActivityIndicator />
          : usedMisidentifications
            ? (
              <>
                <Body2 className="text-center text-darkGray pb-3">
                  {`Based on ${obsScannedCount} random observations of ${targetLabel}`
                    + " near your location, these species were most often identified instead:"}
                </Body2>
                {lookalikesData.length === 0
                  ? <ActivityIndicator />
                  : lookalikesData.map( entry => (
                    <View key={entry.taxonId} className="mb-4 p-3 bg-lightGray rounded-lg">
                      <Pressable
                        onPress={() => navigation.navigate(
                          "TaxonDetails" as never,
                          { id: entry.taxonId } as never,
                        )}
                      >
                        <Body1 className="font-bold text-inatGreen">
                          {entry.commonName ?? entry.name}
                        </Body1>
                        {entry.commonName && (
                          <Body2 className="italic text-inatGreen">{entry.name}</Body2>
                        )}
                      </Pressable>
                      <Body2 className="mt-1">
                        {`Misidentified ${entry.count} time${entry.count !== 1 ? "s" : ""}`}
                      </Body2>
                      <View className="flex-row flex-wrap mt-1 gap-x-3">
                        {entry.observationUuids.map( ( uuid, i ) => (
                          <Pressable
                            accessibilityRole="button"
                            key={uuid}
                            onPress={() => navigation.navigate(
                              "ObsDetails" as never,
                              { uuid } as never,
                            )}
                          >
                            <Body2 className="text-inatGreen underline">
                              {`Obs ${i + 1}`}
                            </Body2>
                          </Pressable>
                        ) )}
                      </View>
                    </View>
                  ) )}
              </>
            )
            : (
              <Body2 className="text-center text-darkGray pb-3">
                {"No misidentification data was found near your location. "
                  + `${lookalikeLabel} is a related species in the same taxonomic group.`}
              </Body2>
            )}
        <View className="pt-2 pb-6">
          <Button
            text="Search 400 More Observations"
            onPress={handleFetchMoreObservations}
            disabled={isFetchingMoreObs}
            loading={isFetchingMoreObs}
            className="w-full"
          />
        </View>
      </ScrollView>
    </SharedStackViewWrapper>
  );
};

export default SpeciesGameWhySpecies;
