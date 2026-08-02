import {
  markNavigationDispatched,
  trackScreenTransition,
  trackUiWork,
} from "sharedHelpers/uiDelayTracker";

const mockInfoWithExtra = jest.fn( );

jest.mock( "sharedHelpers/logger", ( ) => ( {
  log: { extend: ( ) => ( { infoWithExtra: ( ...args ) => mockInfoWithExtra( ...args ) } ) },
} ) );

jest.mock( "navigation/navigationUtils", ( ) => ( {
  getCurrentRoute: ( ) => ( { name: "MyObservations" } ),
} ) );

// The tracker measures until the JS thread goes idle; get there immediately.
global.requestIdleCallback = callback => {
  callback( { didTimeout: false, timeRemaining: ( ) => 50 } );
  return 0;
};

describe( "uiDelayTracker", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    jest.spyOn( Date, "now" ).mockReturnValue( 1_000 );
  } );

  afterEach( ( ) => {
    Date.now.mockRestore( );
  } );

  it( "logs a transition that kept the user waiting, timed from the tap", ( ) => {
    markNavigationDispatched( );
    Date.now.mockReturnValue( 3_500 );

    trackScreenTransition( { fromScreen: "MyObservations", toScreen: "ObsEdit" } );

    expect( mockInfoWithExtra ).toHaveBeenCalledWith(
      "slow_screen_transition",
      expect.objectContaining( {
        fromScreen: "MyObservations",
        toScreen: "ObsEdit",
        totalMs: 2_500,
      } ),
    );
  } );

  it( "ignores a transition fast enough not to notice", ( ) => {
    markNavigationDispatched( );
    Date.now.mockReturnValue( 1_100 );

    trackScreenTransition( { fromScreen: "MyObservations", toScreen: "ObsEdit" } );

    expect( mockInfoWithExtra ).not.toHaveBeenCalled( );
  } );

  it( "does not charge a transition for a tap that changed no screen", ( ) => {
    markNavigationDispatched( );
    // A params-only state change on the screen we're already on consumes the
    // mark rather than leaving it for the next transition to inherit.
    Date.now.mockReturnValue( 3_000 );
    trackScreenTransition( {
      fromScreen: "MyObservations",
      toScreen: "MyObservations",
    } );
    trackScreenTransition( { fromScreen: "MyObservations", toScreen: "ObsEdit" } );

    expect( mockInfoWithExtra ).not.toHaveBeenCalled( );
  } );

  it( "logs work that delayed the screen before navigation was even asked to move", ( ) => {
    Date.now.mockReturnValue( 2_000 );

    trackUiWork( "camera_prepare_and_navigate", 1_000 );

    expect( mockInfoWithExtra ).toHaveBeenCalledWith(
      "slow_ui_work",
      expect.objectContaining( {
        work: "camera_prepare_and_navigate",
        elapsedMs: 1_000,
        screen: "MyObservations",
      } ),
    );
  } );
} );
