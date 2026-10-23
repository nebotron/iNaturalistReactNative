import { useNavigation } from "@react-navigation/native";
import type { ExploreStackScreenProps } from "navigation/types";
import { EXPLORE_V2_ACTION, useExploreV2 } from "providers/ExploreV2Context";
import { useCallback } from "react";
import type { SavedSearch } from "stores/createExploreV2SearchesSlice";
import useStore, { zustandStorage } from "stores/useStore";

const useApplySavedSearch = ( ) => {
  const { dispatch } = useExploreV2( );
  const navigation = useNavigation<ExploreStackScreenProps<"ExploreResults">["navigation"]>( );

  return useCallback( ( search: SavedSearch ) => {
    dispatch( { type: EXPLORE_V2_ACTION.APPLY_SEARCH, search } );
    if ( search.observationsLayout ) {
      // ExploreResults' useStoredLayout listens for this key
      zustandStorage.setItem( "exploreV2ObservationsLayout", search.observationsLayout );
    }
    if ( search.gridOverlays ) {
      useStore.setState( state => ( {
        layout: { ...state.layout, exploreGridOverlays: search.gridOverlays },
      } ) );
    }
    navigation.popTo( "ExploreResults" );
  }, [dispatch, navigation] );
};

export default useApplySavedSearch;
