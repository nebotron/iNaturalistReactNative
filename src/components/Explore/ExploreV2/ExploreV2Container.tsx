import { useRoute } from "@react-navigation/native";
import ExploreStackNavigator
  from "navigation/StackNavigators/ExploreStackNavigator";
import type { TabStackScreenProps } from "navigation/types";
import {
  ExploreV2Provider,
  initialExploreV2State,
  initialStateFromEntryParams,
  useExploreV2,
} from "providers/ExploreV2Context";
import React, { useEffect } from "react";
import useStore from "stores/useStore";

// Remembers the Explore tab's search and view so they survive a tab switch or relaunch
const LastSearchPersister = ( ) => {
  const { state } = useExploreV2( );
  const setLastExploreSearch = useStore( s => s.setLastExploreSearch );
  const {
    subject, location, sortBy, speciesSortBy, filters, activeTab,
  } = state;

  useEffect( ( ) => {
    setLastExploreSearch( {
      subject, location, sortBy, speciesSortBy, filters, activeTab,
    } );
  }, [setLastExploreSearch, subject, location, sortBy, speciesSortBy, filters, activeTab] );

  return null;
};

const ExploreV2Container = ( ) => {
  const { name, params } = useRoute<TabStackScreenProps<"Explore" | "RootExplore">["route"]>( );
  const isRootExplore = name === "RootExplore";
  const restoreLastSearch = isRootExplore && !params?.subject && !params?.location;
  const [initialState] = React.useState( ( ) => {
    const lastSearch = useStore.getState( ).lastExploreSearch;
    if ( restoreLastSearch && lastSearch ) {
      return {
        ...initialExploreV2State,
        ...lastSearch,
        filters: { ...initialExploreV2State.filters, ...lastSearch.filters },
        activeTab: params?.activeTab || lastSearch.activeTab || initialExploreV2State.activeTab,
      };
    }
    return initialStateFromEntryParams( params );
  } );

  return (
    <ExploreV2Provider initialState={initialState}>
      {isRootExplore && <LastSearchPersister />}
      <ExploreStackNavigator showBackButton={!isRootExplore} />
    </ExploreV2Provider>
  );
};

export default ExploreV2Container;
