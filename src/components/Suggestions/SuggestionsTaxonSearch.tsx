import {
  TaxonResult,
  TaxonSearch,
} from "components/SharedComponents";
import React, {
  useCallback,
  useState,
} from "react";
import { useTaxonSearch, useTranslation } from "sharedHooks";

import useNavigateWithTaxonSelected from "./hooks/useNavigateWithTaxonSelected";

const SuggestionsTaxonSearch = ( ) => {
  const [taxonQuery, setTaxonQuery] = useState( "" );
  const {
    taxa, isLoading, addRecentTaxon,
  } = useTaxonSearch( taxonQuery );
  const { t } = useTranslation( );

  const navigateWithTaxonSelected = useNavigateWithTaxonSelected( { vision: false } );

  const renderTaxonResult = useCallback( ( { item: taxon, index } ) => (
    <TaxonResult
      accessibilityHint={t( "Chooses-taxon" )}
      fetchRemote={false}
      first={index === 0}
      handleTaxonOrEditPress={() => {
        addRecentTaxon( taxon );
        navigateWithTaxonSelected( taxon );
      }}
      hideNavButtons
      taxon={taxon}
      testID={`Search.taxa.${taxon.id}`}
    />
  ), [addRecentTaxon, navigateWithTaxonSelected, t] );

  return (
    <TaxonSearch
      focusAfterTransition
      isLoading={isLoading}
      query={taxonQuery}
      renderItem={renderTaxonResult}
      setQuery={setTaxonQuery}
      taxa={taxa}
    />
  );
};

export default SuggestionsTaxonSearch;
