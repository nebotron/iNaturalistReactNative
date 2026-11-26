import { useNavigation, useRoute } from "@react-navigation/native";
import { HOTSPOTS_TAB } from "appConstants/tabs";
import { useLoadSavedSearch } from "components/Explore/hooks/useApplySavedSearch";
import ExploreStackNavigator
  from "navigation/StackNavigators/ExploreStackNavigator";
import type { TabStackScreenProps } from "navigation/types";
import {
  ExploreProvider,
  initialExploreState,
  initialStateFromEntryParams,
  useExplore,
  withoutUnobservedFilter,
} from "providers/ExploreContext";
import React, { useEffect, useRef } from "react";
import useStore from "stores/useStore";

// Remembers the Explore tab's search and view so they survive a tab switch or relaunch
const LastSearchPersister = ( ) => {
  const { state } = useExplore( );
  const setLastExploreSearch = useStore( s => s.setLastExploreSearch );
  const setExploreSessionState = useStore( s => s.setExploreSessionState );
  const {
    subject, location, sortBy, speciesSortBy, filters, activeTab,
  } = state;

  useEffect( ( ) => {
    setLastExploreSearch( {
      subject, location, sortBy, speciesSortBy, filters, activeTab,
    } );
  }, [setLastExploreSearch, subject, location, sortBy, speciesSortBy, filters, activeTab] );

  // The whole state, back stack included, for coming back to the tab this session
  useEffect( ( ) => {
    setExploreSessionState( state );
  }, [setExploreSessionState, state] );

  return null;
};

// Remembers the view and sort chosen in an Explore opened from a hotspot link,
// so the next hotspot link opens the same way
const HotspotLinkViewPersister = ( ) => {
  const { state } = useExplore( );
  const setHotspotLinkView = useStore( s => s.layout.setHotspotLinkView );
  const { activeTab, sortBy, speciesSortBy } = state;
  const previousRef = useRef( { activeTab, sortBy, speciesSortBy } );

  useEffect( ( ) => {
    const previous = previousRef.current;
    previousRef.current = { activeTab, sortBy, speciesSortBy };
    // Save only what was changed here, so an unchanged sort keeps following
    // the Explore search's. The Hotspots view isn't kept, since a hotspot
    // link opening on the Hotspots view would hide what was linked to.
    if ( activeTab !== previous.activeTab && activeTab !== HOTSPOTS_TAB ) {
      setHotspotLinkView( { activeTab } );
    }
    if ( sortBy !== previous.sortBy ) {
      setHotspotLinkView( { sortBy } );
    }
    if ( speciesSortBy !== previous.speciesSortBy ) {
      setHotspotLinkView( { speciesSortBy } );
    }
  }, [setHotspotLinkView, activeTab, sortBy, speciesSortBy] );

  return null;
};

// Loads a saved search sent here from an Explore opened from a hotspot link,
// which closes itself so the saved search replaces the Hotspots view outright
const SavedSearchLoader = ( ) => {
  const { params } = useRoute<TabStackScreenProps<"Explore" | "RootExplore">["route"]>( );
  const navigation = useNavigation<TabStackScreenProps<"Explore">["navigation"]>( );
  const loadSavedSearch = useLoadSavedSearch( );
  const savedSearch = params?.loadSavedSearch;

  useEffect( ( ) => {
    if ( !savedSearch ) return;
    loadSavedSearch( savedSearch );
    // So it isn't loaded again over later changes when this screen remounts
    navigation.setParams( { loadSavedSearch: undefined } );
  }, [savedSearch, loadSavedSearch, navigation] );

  return null;
};

const ExploreContainer = ( ) => {
  const { name, params } = useRoute<TabStackScreenProps<"Explore" | "RootExplore">["route"]>( );
  const isRootExplore = name === "RootExplore";
  const fromHotspot = !isRootExplore && !!params?.fromHotspot;
  const restoreLastSearch = isRootExplore && !params?.subject && !params?.location;
  const [initialState] = React.useState( ( ) => {
    // Coming back to the tab: pick up exactly where the user left it
    const { exploreSessionState } = useStore.getState( );
    if ( restoreLastSearch && exploreSessionState ) {
      return params?.activeTab
        ? { ...exploreSessionState, activeTab: params.activeTab }
        : exploreSessionState;
    }
    const storedSearch = useStore.getState( ).lastExploreSearch;
    const lastSearch = storedSearch && withoutUnobservedFilter( storedSearch );
    if ( restoreLastSearch && lastSearch ) {
      return {
        ...initialExploreState,
        ...lastSearch,
        filters: { ...initialExploreState.filters, ...lastSearch.filters },
        activeTab: params?.activeTab || lastSearch.activeTab || initialExploreState.activeTab,
      };
    }
    const entryState = initialStateFromEntryParams( params );
    if ( !fromHotspot ) return entryState;
    const { hotspotLinkView } = useStore.getState( ).layout;
    return {
      ...entryState,
      activeTab: hotspotLinkView.activeTab,
      sortBy: hotspotLinkView.sortBy || entryState.sortBy,
      speciesSortBy: hotspotLinkView.speciesSortBy || entryState.speciesSortBy,
    };
  } );

  return (
    <ExploreProvider initialState={initialState} fromHotspot={fromHotspot}>
      {isRootExplore && <LastSearchPersister />}
      {fromHotspot && <HotspotLinkViewPersister />}
      <SavedSearchLoader />
      <ExploreStackNavigator showBackButton={!isRootExplore} />
    </ExploreProvider>
  );
};

export default ExploreContainer;
