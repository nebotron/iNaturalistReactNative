// @flow

import {
  normalizeTaxonFilters,
} from "components/Explore/helpers/taxonFilters";
import {
  SearchHeader,
  TaxonResult,
  TaxonSearch,
  ViewWrapper,
} from "components/SharedComponents";
import type { Node } from "react";
import React, {
  useCallback,
  useState,
} from "react";
import { useTranslation } from "sharedHooks";
import useTaxonSearch from "sharedHooks/useTaxonSearch";

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

  const {
    taxa,
    isLoading,
    isUpdatingLocalDb,
    updateLocalSpeciesDb,
  } = useTaxonSearch( taxonQuery );

  const onTaxonSelected = useCallback( taxon => {
    const alreadyAdded = taxonFilters.some( f => f.taxon.id === taxon.id );
    if ( !alreadyAdded ) {
      updateTaxonFilters( normalizeTaxonFilters( [
        ...taxonFilters,
        { taxon, exclude: false },
      ] ) );
    }
    closeModal( );
  }, [closeModal, taxonFilters, updateTaxonFilters] );

  const resetTaxon = useCallback( ( ) => {
    updateTaxonFilters( [] );
    closeModal( );
  }, [updateTaxonFilters, closeModal] );

  const getFilterForTaxon = useCallback( taxonId => (
    taxonFilters.find( filter => filter.taxon.id === taxonId )
  ), [taxonFilters] );

  const renderItem = useCallback( ( { item: taxon, index } ) => {
    const filter = getFilterForTaxon( taxon.id );
    return (
      <TaxonResult
        accessibilityLabel={t( "Choose-taxon" )}
        first={index === 0}
        fetchRemote={false}
        handleCheckmarkPress={() => onTaxonSelected( taxon )}
        handleTaxonOrEditPress={() => onTaxonSelected( taxon )}
        onPressInfo={onPressInfo}
        showCheckmark={!!filter}
        taxon={taxon}
        testID={`Search.taxa.${taxon.id}`}
      />
    );
  }, [
    getFilterForTaxon,
    onPressInfo,
    onTaxonSelected,
    t,
  ] );

  return (
    <ViewWrapper>
      <SearchHeader
        onClose={closeModal}
        headerText={t( "SEARCH-TAXA" )}
        onReset={resetTaxon}
        testID="ExploreTaxonSearch.close"
      />
      <TaxonSearch
        isLoading={isLoading}
        isUpdatingLocalDb={isUpdatingLocalDb}
        query={taxonQuery}
        renderItem={renderItem}
        setQuery={setTaxonQuery}
        taxa={taxa}
        updateLocalSpeciesDb={updateLocalSpeciesDb}
      />
    </ViewWrapper>
  );
};

export default ExploreTaxonSearch;
