import { useNavigation } from "@react-navigation/native";
import type { ApiTaxon } from "api/types";
import type { ExploreTaxonFilter } from "components/Explore/helpers/taxonFilters";
import ExploreTaxonSearch from "components/Explore/SearchScreens/ExploreTaxonSearch";
import Modal from "components/SharedComponents/Modal";
import React from "react";
import type { RealmTaxon } from "realmModels/types";

interface Props {
  closeModal: ( ) => void;
  hideInfoButton?: boolean;
  onPressInfo?: ( ) => void;
  showModal: boolean;
  taxonFilters?: ExploreTaxonFilter[];
  updateTaxon?: ( taxon: RealmTaxon | null ) => void;
  updateTaxonFilters?: ( taxonFilters: ExploreTaxonFilter[] ) => void;
}

const ExploreTaxonSearchModal = ( {
  closeModal,
  hideInfoButton = false,
  onPressInfo,
  showModal,
  taxonFilters,
  updateTaxon,
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
          hideInfoButton={hideInfoButton}
          onPressInfo={( taxon: RealmTaxon | ApiTaxon ) => {
            navigation.push( "TaxonDetails", { id: taxon.id, selectableForExplore: true } );
            closeModal();
            if ( onPressInfo ) {
              onPressInfo( );
            }
          }}
          taxonFilters={taxonFilters}
          updateTaxon={updateTaxon}
          updateTaxonFilters={updateTaxonFilters}
        />
      )}
    />
  );
};

export default ExploreTaxonSearchModal;
