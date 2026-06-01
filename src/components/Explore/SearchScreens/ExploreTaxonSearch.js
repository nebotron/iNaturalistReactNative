// @flow

import {
  normalizeTaxonFilters,
} from "components/Explore/helpers/taxonFilters";
import {
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

  const {
    taxa,
    isLoading,
    isLocal,
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
      <ExploreSearchHeader
        closeModal={closeModal}
        headerText={t( "SEARCH-TAXA" )}
        testID="ExploreTaxonSearch.close"
      />
      <TaxonSearch
        isLoading={isLoading}
        isLocal={isLocal}
        query={taxonQuery}
        renderItem={renderItem}
        setQuery={setTaxonQuery}
        taxa={taxa}
      />
    </ViewWrapper>
  );
};

export default ExploreTaxonSearch;
