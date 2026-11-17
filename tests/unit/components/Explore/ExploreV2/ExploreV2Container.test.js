import { act, render } from "@testing-library/react-native";
import {
  HOTSPOTS_TAB, OBSERVATIONS_TAB, OBSERVERS_TAB, SPECIES_TAB,
} from "appConstants/tabs";
import ExploreV2Container from "components/Explore/ExploreV2/ExploreV2Container";
import { EXPLORE_V2_ACTION } from "providers/ExploreV2Context";
import React from "react";
import { OBSERVATIONS_SORT } from "sharedHelpers/observationsSort";
import useStore from "stores/useStore";

let mockRoute;
jest.mock( "@react-navigation/native", ( ) => ( {
  ...jest.requireActual( "@react-navigation/native" ),
  useRoute: ( ) => mockRoute,
} ) );

// Stands in for the Explore screens, exposing the Explore state they'd see
let mockExplore;
jest.mock( "navigation/StackNavigators/ExploreStackNavigator", ( ) => ( {
  __esModule: true,
  default: ( ) => {
    mockExplore = jest.requireActual( "providers/ExploreV2Context" ).useExploreV2( );
    return null;
  },
} ) );

const hotspotRoute = {
  name: "Explore",
  params: { activeTab: OBSERVATIONS_TAB, fromHotspot: true },
};

const initialLayout = useStore.getState( ).layout;

describe( "ExploreV2Container opened from a hotspot link", ( ) => {
  beforeEach( ( ) => {
    useStore.setState( { layout: initialLayout } );
  } );

  it( "opens with the view and sort last chosen from a hotspot link", ( ) => {
    useStore.getState( ).layout.setHotspotLinkView( {
      activeTab: OBSERVERS_TAB,
      sortBy: OBSERVATIONS_SORT.MOST_FAVED,
    } );
    mockRoute = hotspotRoute;
    render( <ExploreV2Container /> );
    expect( mockExplore.state.activeTab ).toBe( OBSERVERS_TAB );
    expect( mockExplore.state.sortBy ).toBe( OBSERVATIONS_SORT.MOST_FAVED );
  } );

  it( "keeps the view and sort changed there for the next hotspot link", ( ) => {
    mockRoute = hotspotRoute;
    render( <ExploreV2Container /> );
    act( ( ) => mockExplore.dispatch( {
      type: EXPLORE_V2_ACTION.SET_ACTIVE_TAB,
      tab: SPECIES_TAB,
    } ) );
    act( ( ) => mockExplore.dispatch( {
      type: EXPLORE_V2_ACTION.SET_SORT,
      sortBy: OBSERVATIONS_SORT.DATE_OBSERVED_OLDEST,
    } ) );
    const { hotspotLinkView } = useStore.getState( ).layout;
    expect( hotspotLinkView.activeTab ).toBe( SPECIES_TAB );
    expect( hotspotLinkView.sortBy ).toBe( OBSERVATIONS_SORT.DATE_OBSERVED_OLDEST );
  } );

  it( "doesn't keep the Hotspots view", ( ) => {
    mockRoute = hotspotRoute;
    render( <ExploreV2Container /> );
    act( ( ) => mockExplore.dispatch( {
      type: EXPLORE_V2_ACTION.SET_ACTIVE_TAB,
      tab: HOTSPOTS_TAB,
    } ) );
    expect( useStore.getState( ).layout.hotspotLinkView.activeTab ).toBe( OBSERVATIONS_TAB );
  } );

  it( "leaves the hotspot view options alone in other Explores", ( ) => {
    mockRoute = { name: "Explore", params: { activeTab: OBSERVATIONS_TAB } };
    render( <ExploreV2Container /> );
    act( ( ) => mockExplore.dispatch( {
      type: EXPLORE_V2_ACTION.SET_ACTIVE_TAB,
      tab: SPECIES_TAB,
    } ) );
    expect( useStore.getState( ).layout.hotspotLinkView.activeTab ).toBe( OBSERVATIONS_TAB );
  } );
} );
