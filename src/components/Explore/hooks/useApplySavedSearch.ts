import { CommonActions, useNavigation } from "@react-navigation/native";
import relativeSavedSearch from "components/Explore/helpers/relativeSavedSearch";
import {
  useExploreGridOverlays, useExploreLayoutKey,
} from "components/Explore/hooks/useExploreDisplaySettings";
import type { ExploreStackScreenProps } from "navigation/types";
import {
  EXPLORE_ACTION, useExplore,
  useExploreFromHotspot,
} from "providers/ExploreContext";
import { useCallback } from "react";
import type { SavedSearch } from "stores/createExploreSearchesSlice";
import { zustandStorage } from "stores/useStore";

// Loads a saved search into this Explore's state, without navigating
export const useLoadSavedSearch = ( ) => {
  const { dispatch } = useExplore( );
  const layoutKey = useExploreLayoutKey( );
  const { replaceOverlays } = useExploreGridOverlays( );

  return useCallback( ( savedSearch: SavedSearch ) => {
    const search = relativeSavedSearch( savedSearch );
    dispatch( { type: EXPLORE_ACTION.APPLY_SEARCH, search } );
    if ( search.observationsLayout ) {
      // ExploreResults' useStoredLayout listens for this key
      zustandStorage.setItem( layoutKey, search.observationsLayout );
    }
    if ( search.gridOverlays ) {
      replaceOverlays( search.gridOverlays );
    }
  }, [dispatch, layoutKey, replaceOverlays] );
};

// An Explore opened from a hotspot link sits on top of the Explore showing the
// Hotspots view. A search that replaces both is loaded into the Explore
// underneath and this one is closed, leaving no way back to the hotspot.
// Returns false when this Explore wasn't opened from a hotspot link.
export const useReplaceHotspotExplore = ( ) => {
  const navigation = useNavigation<ExploreStackScreenProps<"ExploreResults">["navigation"]>( );
  const fromHotspot = useExploreFromHotspot( );

  return useCallback( ( savedSearch: SavedSearch ) => {
    const tabStack = fromHotspot
      ? navigation.getParent( )
      : undefined;
    const tabState = tabStack?.getState( );
    const opener = tabState && tabState.index > 0
      ? tabState.routes[tabState.index - 1]
      : undefined;
    if ( !tabStack || !opener ) return false;
    tabStack.dispatch( {
      ...CommonActions.setParams( { loadSavedSearch: savedSearch } ),
      source: opener.key,
    } );
    tabStack.goBack( );
    return true;
  }, [navigation, fromHotspot] );
};

const useApplySavedSearch = ( ) => {
  const navigation = useNavigation<ExploreStackScreenProps<"ExploreResults">["navigation"]>( );
  const replaceHotspotExplore = useReplaceHotspotExplore( );
  const loadSavedSearch = useLoadSavedSearch( );

  return useCallback( ( savedSearch: SavedSearch ) => {
    if ( replaceHotspotExplore( savedSearch ) ) return;
    loadSavedSearch( savedSearch );
    navigation.popTo( "ExploreResults" );
  }, [navigation, replaceHotspotExplore, loadSavedSearch] );
};

export default useApplySavedSearch;
