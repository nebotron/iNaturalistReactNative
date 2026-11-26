import { fireEvent, screen } from "@testing-library/react-native";
import CustomTabBarContainer from "navigation/BottomTabNavigator/CustomTabBarContainer";
import React from "react";
import { renderComponent } from "tests/helpers/render";

jest.mock( "sharedHooks/useCurrentUser", ( ) => ( {
  __esModule: true,
  default: () => undefined,
} ) );

jest.mock( "sharedHooks/useAuthenticatedQuery", () => ( {
  __esModule: true,
  default: () => ( {
    data: 0,
    refetch: () => undefined,
  } ),
} ) );

const tabState = ( activeTabName, meTabStack ) => {
  const routes = [
    { key: "menu", name: "MenuTab" },
    { key: "explore", name: "ExploreTab" },
    { key: "me", name: "ObservationsTab", state: meTabStack },
    { key: "notifications", name: "NotificationsTab" },
  ];
  return {
    index: routes.findIndex( r => r.name === activeTabName ),
    routes,
  };
};

const showTabBar = state => {
  const navigation = {
    getState: jest.fn( ( ) => state ),
    dispatch: jest.fn( ),
    navigate: jest.fn( ),
  };
  renderComponent( <CustomTabBarContainer navigation={navigation} state={state} /> );
  return navigation;
};

const pressMeTab = ( ) => fireEvent.press( screen.getByTestId( "NavButton.personIcon" ) );

describe( "CustomTabBarContainer Me tab", ( ) => {
  it( "switches to the observation list it already shows without rebuilding it", ( ) => {
    const navigation = showTabBar( tabState( "ExploreTab", {
      index: 0,
      routes: [{ key: "obsList", name: "ObsList" }],
    } ) );

    pressMeTab( );

    expect( navigation.navigate ).toHaveBeenCalledWith( "ObservationsTab" );
    expect( navigation.dispatch ).not.toHaveBeenCalled( );
  } );

  it( "doesn't rebuild the list when pressed while showing it", ( ) => {
    const navigation = showTabBar( tabState( "ObservationsTab", {
      index: 0,
      routes: [{ key: "obsList", name: "ObsList" }],
    } ) );

    pressMeTab( );

    expect( navigation.dispatch ).not.toHaveBeenCalled( );
  } );

  it( "opens a tab that was never visited without a reset", ( ) => {
    const navigation = showTabBar( tabState( "ExploreTab", undefined ) );

    pressMeTab( );

    expect( navigation.navigate ).toHaveBeenCalledWith( "ObservationsTab" );
    expect( navigation.dispatch ).not.toHaveBeenCalled( );
  } );

  it( "returns to the list when a screen is open above it", ( ) => {
    const navigation = showTabBar( tabState( "ExploreTab", {
      index: 1,
      routes: [
        { key: "obsList", name: "ObsList" },
        { key: "groupPhotos", name: "GroupPhotos" },
      ],
    } ) );

    pressMeTab( );

    expect( navigation.dispatch ).toHaveBeenCalledTimes( 1 );
    expect( navigation.navigate ).not.toHaveBeenCalled( );
  } );

  it( "returns to the list when its search screen is open", ( ) => {
    const navigation = showTabBar( tabState( "ObservationsTab", {
      index: 0,
      routes: [{
        key: "obsList",
        name: "ObsList",
        state: {
          index: 1,
          routes: [
            { key: "results", name: "MyObservationsResults" },
            { key: "search", name: "SearchMyObservations" },
          ],
        },
      }],
    } ) );

    pressMeTab( );

    expect( navigation.dispatch ).toHaveBeenCalledTimes( 1 );
  } );
} );
