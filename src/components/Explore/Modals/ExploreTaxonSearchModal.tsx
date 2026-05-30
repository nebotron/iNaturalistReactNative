import { useNavigation } from "@react-navigation/native";
import type { ApiTaxon } from "api/types";
import type { ExploreTaxonFilter } from "components/Explore/helpers/taxonFilters";
import ExploreTaxonSearch from "components/Explore/SearchScreens/ExploreTaxonSearch";
import Modal from "components/SharedComponents/Modal";
import React from "react";
import type { RealmTaxon } from "realmModels/types";

interface Props {
  closeModal: ( ) => void;
  onPressInfo?: ( ) => void;
  showModal: boolean;
  taxonFilters: ExploreTaxonFilter[];
  updateTaxonFilters: ( taxonFilters: ExploreTaxonFilter[] ) => void;
}

const ExploreTaxonSearchModal = ( {
  closeModal,
  onPressInfo,
  showModal,
  taxonFilters,
  updateTaxonFilters,
}: Props ) => {
  const navigation = useNavigation( );
  return (
    <Modal
      showModal={showModal}
      fullScreen
      closeModal={closeModal}
      disableSwipeDirection
      modal={(
        <ExploreTaxonSearch
          closeModal={closeModal}
          onPressInfo={( taxon: RealmTaxon | ApiTaxon ) => {
            navigation.push( "TaxonDetails", { id: taxon.id } );
            closeModal();
            if ( onPressInfo ) {
              onPressInfo( );
            }
          }}
          taxonFilters={taxonFilters}
          updateTaxonFilters={updateTaxonFilters}
        />
      )}
    />
  );
};

export default ExploreTaxonSearchModal;
