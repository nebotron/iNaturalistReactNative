import classnames from "classnames";
import {
  getRelativeDateOffsets,
  isSavedExploreFilterActive,
  prepareExploreStateForStorage,
  resolveRelativeDates,
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
import useStore, { zustandStorage } from "stores/useStore";

interface Props {
  onLoadFilter: () => void;
  onOpenDeleteFilter: ( filter: {
    id: string;
    name: string;
  } ) => void;
  onOpenSaveSheet: () => void;
}

const ExploreSavedFiltersSection = ( {
  onLoadFilter,
  onOpenDeleteFilter,
  onOpenSaveSheet,
}: Props ) => {
  const { t } = useTranslation( );
  const { dispatch, state } = useExplore( );
  const savedExploreFilters = useStore( storeState => storeState.savedExploreFilters );
  const updateSavedExploreFilter = useStore(
    storeState => storeState.updateSavedExploreFilter,
  );
  const rootExploreView = useStore( storeState => storeState.rootExploreView );
  const setRootExploreView = useStore( storeState => storeState.setRootExploreView );

  const sortedSavedFilters = useMemo(
    ( ) => sortSavedExploreFilters( savedExploreFilters ),
    [savedExploreFilters],
  );

  const activeSavedFilterId = useMemo( ( ) => {
    const currentParams = prepareExploreStateForStorage( state );
    const activeFilter = sortedSavedFilters.find(
      savedFilter => isSavedExploreFilterActive( currentParams, savedFilter ),
    );
    return activeFilter?.id;
  }, [state, sortedSavedFilters] );

  const loadSavedFilter = ( savedFilterId: string ) => {
    const savedFilter = savedExploreFilters.find(
      filter => filter.id === savedFilterId,
    );

    if ( !savedFilter ) {
      return;
    }

    dispatch( {
      type: EXPLORE_ACTION.USE_STORED_STATE,
      storedState: resolveRelativeDates(
        savedFilter.params,
        {
          relativeD1: savedFilter.relativeD1,
          relativeD2: savedFilter.relativeD2,
          relativeObservedOn: savedFilter.relativeObservedOn,
          relativeCreatedD1: savedFilter.relativeCreatedD1,
          relativeCreatedD2: savedFilter.relativeCreatedD2,
          relativeCreatedOn: savedFilter.relativeCreatedOn,
        },
      ),
    } );

    if ( savedFilter.view ) {
      setRootExploreView( savedFilter.view );
    }
    if ( savedFilter.observationsLayout ) {
      zustandStorage.setItem( "exploreObservationsLayout", savedFilter.observationsLayout );
    }

    // Immediately apply the filter and show the results
    onLoadFilter( );
  };

  const overwriteSavedFilter = ( savedFilterId: string ) => {
    const observationsLayout
      = zustandStorage.getItem( "exploreObservationsLayout" ) as string ?? "map";
    const relativeDates = getRelativeDateOffsets( state );
    updateSavedExploreFilter(
      savedFilterId,
      prepareExploreStateForStorage( state ),
      rootExploreView,
      observationsLayout,
      relativeDates,
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
        : sortedSavedFilters.map( savedFilter => {
          const isActive = savedFilter.id === activeSavedFilterId;
          return (
            <View
              key={savedFilter.id}
              className="flex-row items-center mb-4"
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t( "Load-saved-filter" )}
                accessibilityState={{ selected: isActive }}
                className={classnames(
                  "flex-1 pr-3 py-2 px-3 rounded-lg border border-[2px]",
                  isActive
                    ? "border-inatGreen bg-inatGreen/10"
                    : "border-transparent",
                )}
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
          );
        } ) }
    </View>
  );
};

export default ExploreSavedFiltersSection;
