import {
  prepareExploreStateForStorage,
  sortSavedExploreFilters,
} from "components/Explore/helpers/savedExploreFilters";
import {
  Body1,
  Body3,
  Button,
  Heading4,
  INatIconButton,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import {
  EXPLORE_ACTION,
  useExplore,
} from "providers/ExploreContext";
import React, { useMemo } from "react";
import { useTranslation } from "sharedHooks";
import useStore from "stores/useStore";

interface Props {
  onOpenDeleteFilter: ( filter: {
    id: string;
    name: string;
  } ) => void;
  onOpenSaveSheet: () => void;
}

const ExploreSavedFiltersSection = ( {
  onOpenDeleteFilter,
  onOpenSaveSheet,
}: Props ) => {
  const { t } = useTranslation( );
  const { dispatch, state } = useExplore( );
  const savedExploreFilters = useStore( storeState => storeState.savedExploreFilters );
  const updateSavedExploreFilter = useStore(
    storeState => storeState.updateSavedExploreFilter,
  );

  const sortedSavedFilters = useMemo(
    ( ) => sortSavedExploreFilters( savedExploreFilters ),
    [savedExploreFilters],
  );

  const loadSavedFilter = ( savedFilterId: string ) => {
    const savedFilter = savedExploreFilters.find(
      filter => filter.id === savedFilterId,
    );

    if ( !savedFilter ) {
      return;
    }

    dispatch( {
      type: EXPLORE_ACTION.USE_STORED_STATE,
      storedState: savedFilter.params,
    } );
  };

  const overwriteSavedFilter = ( savedFilterId: string ) => {
    updateSavedExploreFilter(
      savedFilterId,
      prepareExploreStateForStorage( state ),
    );
  };

  return (
    <View className="mb-8 px-5">
      <Heading4 className="mb-5">{t( "Saved-filters" )}</Heading4>
      <Button
        className="shrink mb-5"
        level="neutral"
        text={t( "Save-current-filters" )}
        onPress={onOpenSaveSheet}
        accessibilityLabel={t( "Save-current-filters" )}
      />
      {sortedSavedFilters.length === 0
        ? (
          <Body3 className="text-darkGray">{t( "No-saved-filters-yet" )}</Body3>
        )
        : sortedSavedFilters.map( savedFilter => (
          <View
            key={savedFilter.id}
            className="flex-row items-center mb-4"
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t( "Load-saved-filter" )}
              className="flex-1 pr-3"
              onPress={() => loadSavedFilter( savedFilter.id )}
            >
              <Body1>{savedFilter.name}</Body1>
            </Pressable>
            <INatIconButton
              icon="pencil-outline"
              onPress={() => overwriteSavedFilter( savedFilter.id )}
              size={20}
              accessibilityLabel={t( "Overwrite-saved-filter" )}
              className="mr-3"
            />
            <INatIconButton
              icon="trash-outline"
              onPress={() => onOpenDeleteFilter( {
                id: savedFilter.id,
                name: savedFilter.name,
              } )}
              size={20}
              accessibilityLabel={t( "Delete-saved-filter" )}
            />
          </View>
        ) ) }
    </View>
  );
};

export default ExploreSavedFiltersSection;
