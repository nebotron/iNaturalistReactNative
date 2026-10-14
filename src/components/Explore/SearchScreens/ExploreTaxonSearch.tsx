import type { ApiTaxon } from "api/types";
import type { ExploreTaxonFilter } from "components/Explore/helpers/taxonFilters";
import {
  normalizeTaxonFilters,
  toExploreTaxonFilterTaxon,
} from "components/Explore/helpers/taxonFilters";
import {
  SearchHeader,
  TaxonResult,
  TaxonSearch,
  ViewWrapper,
} from "components/SharedComponents";
import React, {
  useCallback,
  useState,
} from "react";
import type { ListRenderItem } from "react-native";
import type { RealmTaxon } from "realmModels/types";
import useTaxonSearch from "sharedHooks/useTaxonSearch";
import useTranslation from "sharedHooks/useTranslation";

interface Props {
  closeModal: ( ) => void;
  hideInfoButton?: boolean;
  onPressInfo?: ( taxon: RealmTaxon | ApiTaxon ) => void;
  taxonFilters?: ExploreTaxonFilter[];
  updateTaxonFilters: ( taxonFilters: ExploreTaxonFilter[] ) => void;
}

const ExploreTaxonSearch = ( {
  closeModal,
  hideInfoButton = false,
  onPressInfo,
  taxonFilters = [],
  updateTaxonFilters,
}: Props ) => {
  const { t } = useTranslation( );
  const [taxonQuery, setTaxonQuery] = useState( "" );

  const {
    taxa,
    isLoading,
  } = useTaxonSearch( taxonQuery );

  const onTaxonSelected = useCallback( ( taxon: RealmTaxon ) => {
    const alreadyAdded = taxonFilters.some( f => f.taxon.id === taxon.id );
    if ( !alreadyAdded ) {
      updateTaxonFilters( normalizeTaxonFilters( [
        ...taxonFilters,
        { taxon: toExploreTaxonFilterTaxon( taxon ), exclude: false },
      ] ) );
    }
    closeModal( );
  }, [closeModal, taxonFilters, updateTaxonFilters] );

  const resetTaxon = useCallback( ( ) => {
    updateTaxonFilters( [] );
    closeModal( );
  }, [updateTaxonFilters, closeModal] );

  const getFilterForTaxon = useCallback( ( taxonId: number ) => (
    taxonFilters.find( filter => filter.taxon.id === taxonId )
  ), [taxonFilters] );

  const renderItem: ListRenderItem<RealmTaxon> = useCallback(
    ( { item: taxon, index } ) => (
      <TaxonResult
        first={index === 0}
        fetchRemote={false}
        handleTaxonOrEditPress={() => onTaxonSelected( taxon )}
        hideInfoButton={hideInfoButton}
        onPressInfo={onPressInfo}
        showCheckmark={!!getFilterForTaxon( taxon.id )}
        taxon={taxon}
        testID={`Search.taxa.${taxon.id}`}
      />
    ),
    [
      getFilterForTaxon,
      hideInfoButton,
      onPressInfo,
      onTaxonSelected,
    ],
  );

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
        query={taxonQuery}
        renderItem={renderItem}
        setQuery={setTaxonQuery}
        taxa={taxa}
      />
    </ViewWrapper>
  );
};

export default ExploreTaxonSearch;
