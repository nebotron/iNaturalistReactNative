import { act, render } from "@testing-library/react-native";
import {
  HOTSPOTS_TAB, OBSERVATIONS_TAB, OBSERVERS_TAB, SPECIES_TAB,
} from "appConstants/tabs";
import ExploreContainer from "components/Explore/ExploreContainer";
import { EXPLORE_ACTION } from "providers/ExploreContext";
import React from "react";
import { OBSERVATIONS_SORT } from "sharedHelpers/observationsSort";
import useStore from "stores/useStore";
import { savedSearch as buildSavedSearch } from "tests/helpers/savedSearch";

let mockRoute;
const mockSetParams = jest.fn( );
const mockNavigation = { setParams: mockSetParams };
jest.mock( "@react-navigation/native", ( ) => ( {
  ...jest.requireActual( "@react-navigation/native" ),
  useRoute: ( ) => mockRoute,
  useNavigation: ( ) => mockNavigation,
} ) );

// Stands in for the Explore screens, exposing the Explore state they'd see
let mockExplore;
jest.mock( "navigation/StackNavigators/ExploreStackNavigator", ( ) => ( {
  __esModule: true,
  default: ( ) => {
    mockExplore = jest.requireActual( "providers/ExploreContext" ).useExplore( );
    return null;
  },
} ) );

const hotspotRoute = {
  name: "Explore",
  params: { activeTab: OBSERVATIONS_TAB, fromHotspot: true },
};

const initialLayout = useStore.getState( ).layout;

describe( "ExploreContainer opened from a hotspot link", ( ) => {
  beforeEach( ( ) => {
    useStore.setState( { layout: initialLayout } );
  } );

  it( "opens with the view and sort last chosen from a hotspot link", ( ) => {
    useStore.getState( ).layout.setHotspotLinkView( {
      activeTab: OBSERVERS_TAB,
      sortBy: OBSERVATIONS_SORT.MOST_FAVED,
    } );
    mockRoute = hotspotRoute;
    render( <ExploreContainer /> );
    expect( mockExplore.state.activeTab ).toBe( OBSERVERS_TAB );
    expect( mockExplore.state.sortBy ).toBe( OBSERVATIONS_SORT.MOST_FAVED );
  } );

  it( "keeps the view and sort changed there for the next hotspot link", ( ) => {
    mockRoute = hotspotRoute;
    render( <ExploreContainer /> );
    act( ( ) => mockExplore.dispatch( {
      type: EXPLORE_ACTION.SET_ACTIVE_TAB,
      tab: SPECIES_TAB,
    } ) );
    act( ( ) => mockExplore.dispatch( {
      type: EXPLORE_ACTION.SET_SORT,
      sortBy: OBSERVATIONS_SORT.DATE_OBSERVED_OLDEST,
    } ) );
    const { hotspotLinkView } = useStore.getState( ).layout;
    expect( hotspotLinkView.activeTab ).toBe( SPECIES_TAB );
    expect( hotspotLinkView.sortBy ).toBe( OBSERVATIONS_SORT.DATE_OBSERVED_OLDEST );
  } );

  it( "doesn't keep the Hotspots view", ( ) => {
    mockRoute = hotspotRoute;
    render( <ExploreContainer /> );
    act( ( ) => mockExplore.dispatch( {
      type: EXPLORE_ACTION.SET_ACTIVE_TAB,
      tab: HOTSPOTS_TAB,
    } ) );
    expect( useStore.getState( ).layout.hotspotLinkView.activeTab ).toBe( OBSERVATIONS_TAB );
  } );

  it( "leaves the hotspot view options alone in other Explores", ( ) => {
    mockRoute = { name: "Explore", params: { activeTab: OBSERVATIONS_TAB } };
    render( <ExploreContainer /> );
    act( ( ) => mockExplore.dispatch( {
      type: EXPLORE_ACTION.SET_ACTIVE_TAB,
      tab: SPECIES_TAB,
    } ) );
    expect( useStore.getState( ).layout.hotspotLinkView.activeTab ).toBe( OBSERVATIONS_TAB );
  } );
} );

describe( "ExploreContainer sent a saved search", ( ) => {
  it( "loads it, replacing the Hotspots view, and clears the request", ( ) => {
    const search = buildSavedSearch( { activeTab: SPECIES_TAB } );
    mockRoute = {
      name: "RootExplore",
      params: { activeTab: HOTSPOTS_TAB, loadSavedSearch: search },
    };
    render( <ExploreContainer /> );
    expect( mockExplore.state.activeTab ).toBe( SPECIES_TAB );
    expect( mockExplore.state.appliedSearchCount ).toBe( 1 );
    expect( mockExplore.state.backStack ).toEqual( [] );
    expect( mockSetParams ).toHaveBeenCalledWith( { loadSavedSearch: undefined } );
  } );
} );
