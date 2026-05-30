import {
  EXPLORE_ACTION,
  exploreReducer,
  initialExploreState,
  PLACE_MODE,
} from "providers/ExploreContext";
import { DEFAULT_NEARBY_RADIUS_KM } from "sharedHelpers/nearbyRadius";

describe( "Explore nearby radius", ( ) => {
  it( "stores the nearby radius preference and applies it in nearby mode", ( ) => {
    const nearbyState = {
      ...initialExploreState,
      placeMode: PLACE_MODE.NEARBY,
      lat: 47.6,
      lng: -122.3,
      radius: DEFAULT_NEARBY_RADIUS_KM,
      nearbyRadiusKm: DEFAULT_NEARBY_RADIUS_KM,
    };

    const updatedState = exploreReducer( nearbyState, {
      type: EXPLORE_ACTION.SET_NEARBY_RADIUS,
      radius: 25,
    } );

    expect( updatedState.nearbyRadiusKm ).toBe( 25 );
    expect( updatedState.radius ).toBe( 25 );
  } );

  it( "restores nearbyRadiusKm when loading stored explore params", ( ) => {
    const { nearbyRadiusKm: _nearbyRadiusKm, ...storedState } = {
      ...initialExploreState,
      placeMode: PLACE_MODE.NEARBY,
      radius: 10,
    };

    const restoredState = exploreReducer( initialExploreState, {
      type: EXPLORE_ACTION.USE_STORED_STATE,
      storedState,
    } );

    expect( restoredState.nearbyRadiusKm ).toBe( 10 );
  } );
} );
