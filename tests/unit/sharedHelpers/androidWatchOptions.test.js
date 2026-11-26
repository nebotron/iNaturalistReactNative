import Geolocation from "@react-native-community/geolocation";
import { NativeModules, Platform } from "react-native";
import { mergeWatchOptions } from "sharedHelpers/androidWatchOptions";
import { clearWatch, watchPosition } from "sharedHelpers/geolocationWrapper";

const historyOptions = {
  enableHighAccuracy: false,
  balancedPowerAccuracy: true,
  distanceFilter: 50,
  interval: 120000,
  fastestInterval: 120000,
};
const preciseOptions = { enableHighAccuracy: true, distanceFilter: 0, maximumAge: 0 };

describe( "mergeWatchOptions", ( ) => {
  it( "takes the most accurate and most frequent of the watches", ( ) => {
    expect( mergeWatchOptions( [historyOptions, preciseOptions] ) ).toEqual( {
      enableHighAccuracy: true,
      balancedPowerAccuracy: true,
      distanceFilter: 0,
      // The precise watch leaves interval to the library's 10 s default
      interval: 10000,
      fastestInterval: 120000,
      maximumAge: 0,
    } );
  } );
} );

describe( "watchPosition on Android", ( ) => {
  const originalOS = Platform.OS;
  const native = { startObserving: jest.fn( ), stopObserving: jest.fn( ) };
  let nextId = 1000;

  beforeAll( ( ) => {
    Platform.OS = "android";
    NativeModules.RNCGeolocation = native;
    Geolocation.watchPosition.mockImplementation( ( ) => {
      nextId += 1;
      return nextId;
    } );
  } );

  afterAll( ( ) => {
    Platform.OS = originalOS;
  } );

  it( "restarts native updates with what every active watch needs", ( ) => {
    const history = watchPosition( jest.fn( ), jest.fn( ), historyOptions );
    // The library started native updates with the first watch's own options
    expect( native.startObserving ).not.toHaveBeenCalled( );

    const precise = watchPosition( jest.fn( ), jest.fn( ), preciseOptions );
    expect( native.stopObserving ).toHaveBeenCalledTimes( 1 );
    expect( native.startObserving ).toHaveBeenLastCalledWith(
      expect.objectContaining( { enableHighAccuracy: true, distanceFilter: 0 } ),
    );

    clearWatch( precise );
    expect( native.startObserving ).toHaveBeenLastCalledWith(
      expect.objectContaining( {
        enableHighAccuracy: false,
        balancedPowerAccuracy: true,
        distanceFilter: 50,
      } ),
    );

    native.startObserving.mockClear( );
    clearWatch( history );
    expect( native.startObserving ).not.toHaveBeenCalled( );
  } );
} );
