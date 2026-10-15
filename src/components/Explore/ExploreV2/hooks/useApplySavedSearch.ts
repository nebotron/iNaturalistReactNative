import { useNavigation } from "@react-navigation/native";
import type { ExploreStackScreenProps } from "navigation/types";
import { EXPLORE_V2_ACTION, useExploreV2 } from "providers/ExploreV2Context";
import { useCallback } from "react";
import type { SavedSearch } from "stores/createExploreV2SearchesSlice";

const useApplySavedSearch = ( ) => {
  const { dispatch } = useExploreV2( );
  const navigation = useNavigation<ExploreStackScreenProps<"ExploreResults">["navigation"]>( );

  return useCallback( ( search: SavedSearch ) => {
    dispatch( { type: EXPLORE_V2_ACTION.APPLY_SEARCH, search } );
    navigation.popTo( "ExploreResults" );
  }, [dispatch, navigation] );
};

export default useApplySavedSearch;
