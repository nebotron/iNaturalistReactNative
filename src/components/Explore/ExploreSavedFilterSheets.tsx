import {
  prepareExploreStateForStorage,
} from "components/Explore/helpers/savedExploreFilters";
import {
  TextInputSheet,
  WarningSheet,
} from "components/SharedComponents";
import {
  useExplore,
} from "providers/ExploreContext";
import React from "react";
import { Alert } from "react-native";
import { useTranslation } from "sharedHooks";
import useStore from "stores/useStore";

interface Props {
  filterToDelete: null | {
    id: string;
    name: string;
  };
  onCloseDeleteFilter: () => void;
  onCloseSaveSheet: () => void;
  showSaveSheet: boolean;
}

const ExploreSavedFilterSheets = ( {
  filterToDelete,
  onCloseDeleteFilter,
  onCloseSaveSheet,
  showSaveSheet,
}: Props ) => {
  const { t } = useTranslation( );
  const { state } = useExplore( );
  const addSavedExploreFilter = useStore( storeState => storeState.addSavedExploreFilter );
  const removeSavedExploreFilter = useStore( storeState => storeState.removeSavedExploreFilter );
  const rootExploreView = useStore( storeState => storeState.rootExploreView );

  const saveCurrentFilters = ( name: string ) => {
    const saved = addSavedExploreFilter(
      name,
      prepareExploreStateForStorage( state ),
      rootExploreView,
    );

    if ( !saved ) {
      Alert.alert(
        t( "Saved-filter-already-exists-title" ),
        t( "Saved-filter-already-exists-description" ),
      );
      return false;
    }

    return true;
  };

  return (
    <>
      {showSaveSheet && (
        <TextInputSheet
          buttonText={t( "SAVE" )}
          confirm={saveCurrentFilters}
          headerText={t( "Save-current-filters" )}
          insideModal
          multiline={false}
          onPressClose={onCloseSaveSheet}
          placeholder={t( "Saved-filter-name-placeholder" )}
          maxLength={100}
        />
      )}
      {filterToDelete && (
        <WarningSheet
          buttonText={t( "DELETE" )}
          confirm={() => {
            removeSavedExploreFilter( filterToDelete.id );
            onCloseDeleteFilter( );
          }}
          handleSecondButtonPress={onCloseDeleteFilter}
          headerText={t( "Delete-saved-filter-title" )}
          loading={false}
          onPressClose={onCloseDeleteFilter}
          secondButtonText={t( "CANCEL" )}
          text={t( "Delete-saved-filter-description", {
            name: filterToDelete.name,
          } )}
          insideModal
        />
      )}
    </>
  );
};

export default ExploreSavedFilterSheets;
