import { useNavigation } from "@react-navigation/native";
import relativeSavedSearch from "components/Explore/ExploreV2/helpers/relativeSavedSearch";
import {
  useExploreGridOverlays, useExploreLayoutKey,
} from "components/Explore/ExploreV2/hooks/useExploreDisplaySettings";
import type { ExploreStackScreenProps } from "navigation/types";
import { EXPLORE_V2_ACTION, useExploreV2 } from "providers/ExploreV2Context";
import { useCallback } from "react";
import type { SavedSearch } from "stores/createExploreV2SearchesSlice";
import { zustandStorage } from "stores/useStore";

const useApplySavedSearch = ( ) => {
  const { dispatch } = useExploreV2( );
  const navigation = useNavigation<ExploreStackScreenProps<"ExploreResults">["navigation"]>( );
  const layoutKey = useExploreLayoutKey( );
  const { replaceOverlays } = useExploreGridOverlays( );

  return useCallback( ( savedSearch: SavedSearch ) => {
    const search = relativeSavedSearch( savedSearch );
    dispatch( { type: EXPLORE_V2_ACTION.APPLY_SEARCH, search } );
    if ( search.observationsLayout ) {
      // ExploreResults' useStoredLayout listens for this key
      zustandStorage.setItem( layoutKey, search.observationsLayout );
    }
    if ( search.gridOverlays ) {
      replaceOverlays( search.gridOverlays );
    }
    navigation.popTo( "ExploreResults" );
  }, [dispatch, navigation, layoutKey, replaceOverlays] );
};

export default useApplySavedSearch;
