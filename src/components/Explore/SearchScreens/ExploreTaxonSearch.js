// @flow

import {
  normalizeTaxonFilters,
  removeTaxonFilter,
  toggleTaxonFilter,
} from "components/Explore/helpers/taxonFilters";
import {
  Button,
  ButtonBar,
  DisplayTaxon,
  INatIconButton,
  TaxonResult,
  TaxonSearch,
  ViewWrapper,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import type { Node } from "react";
import React, {
  useCallback,
  useState,
} from "react";
import { useTranslation } from "sharedHooks";
import useTaxonSearch from "sharedHooks/useTaxonSearch";

import ExploreSearchHeader from "./ExploreSearchHeader";

type Props = {
  closeModal: Function,
  onPressInfo?: Function,
  taxonFilters?: Object[],
  updateTaxonFilters: Function,
};

const ExploreTaxonSearch = ( {
  closeModal,
  onPressInfo,
  taxonFilters = [],
  updateTaxonFilters,
}: Props ): Node => {
  const { t } = useTranslation( );
  const [taxonQuery, setTaxonQuery] = useState( "" );
  const [selectedFilters, setSelectedFilters] = useState( taxonFilters );
  const [excludeMode, setExcludeMode] = useState( false );

  const {
    taxa,
    isLoading,
    isLocal,
  } = useTaxonSearch( taxonQuery );

  const applyFilters = useCallback( ( ) => {
    updateTaxonFilters( normalizeTaxonFilters( selectedFilters ) );
    closeModal( );
  }, [closeModal, selectedFilters, updateTaxonFilters] );

  const resetTaxonFilters = useCallback(
    ( ) => {
      setSelectedFilters( [] );
    },
    [],
  );

  const onTaxonToggled = useCallback( newTaxon => {
    setSelectedFilters( current => toggleTaxonFilter(
      current,
      newTaxon,
      excludeMode,
    ) );
  }, [excludeMode] );

  const getFilterForTaxon = useCallback( taxonId => (
    selectedFilters.find( filter => filter.taxon.id === taxonId )
  ), [selectedFilters] );

  const renderItem = useCallback( ( { item: taxon, index } ) => {
    const filter = getFilterForTaxon( taxon.id );
    return (
      <TaxonResult
        accessibilityLabel={t( "Choose-taxon" )}
        first={index === 0}
        fetchRemote={false}
        handleCheckmarkPress={() => onTaxonToggled( taxon )}
        handleTaxonOrEditPress={() => onTaxonToggled( taxon )}
        onPressInfo={onPressInfo}
        showCheckmark={!!filter}
        activeColor={filter?.exclude
          ? "warningRed"
          : undefined}
        taxon={taxon}
        testID={`Search.taxa.${taxon.id}`}
      />
    );
  }, [
    getFilterForTaxon,
    onPressInfo,
    onTaxonToggled,
    t,
  ] );

  const modeButtons = [
    {
      title: t( "Include-taxon" ),
      onPress: () => setExcludeMode( false ),
      isPrimary: !excludeMode,
      className: "w-1/2 mx-2",
    },
    {
      title: t( "Exclude-taxon" ),
      onPress: () => setExcludeMode( true ),
      isPrimary: excludeMode,
      className: "w-1/2 mx-2",
    },
  ];

  return (
    <ViewWrapper>
      <ExploreSearchHeader
        closeModal={closeModal}
        headerText={t( "SEARCH-TAXA" )}
        resetFilters={resetTaxonFilters}
        testID="ExploreTaxonSearch.close"
      />
      {selectedFilters.length > 0 && (
        <View className="px-4 pb-4 bg-white">
          {selectedFilters.map( filter => (
            <View
              key={`selected-taxon-${filter.taxon.id}-${filter.exclude}`}
              className="flex-row items-center justify-between mb-3"
            >
              <DisplayTaxon
                taxon={filter.taxon}
                showInfoButton={false}
                showCheckmark={false}
              />
              <View className="flex-row items-center">
                <Button
                  level={filter.exclude
                    ? "neutral"
                    : "focus"}
                  text={filter.exclude
                    ? t( "Exclude-taxon" )
                    : t( "Include-taxon" )}
                  onPress={() => setSelectedFilters(
                    current => toggleTaxonFilter(
                      current,
                      filter.taxon,
                      !filter.exclude,
                    ),
                  )}
                  className="mr-2 shrink"
                />
                <INatIconButton
                  icon="close"
                  size={20}
                  onPress={() => setSelectedFilters(
                    current => removeTaxonFilter( current, filter.taxon.id ),
                  )}
                  accessibilityLabel={t( "Remove-taxon-filter" )}
                />
              </View>
            </View>
          ) )}
        </View>
      )}
      <ButtonBar
        buttonConfiguration={modeButtons}
        containerClass="px-4 py-3 bg-white"
      />
      <TaxonSearch
        isLoading={isLoading}
        isLocal={isLocal}
        query={taxonQuery}
        renderItem={renderItem}
        setQuery={setTaxonQuery}
        taxa={taxa}
      />
      <ButtonBar>
        <Button
          level="focus"
          text={t( "APPLY-FILTERS" )}
          onPress={applyFilters}
          accessibilityLabel={t( "Apply-filters" )}
        />
      </ButtonBar>
    </ViewWrapper>
  );
};

export default ExploreTaxonSearch;
