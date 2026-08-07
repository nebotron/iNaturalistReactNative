import { AppState } from "react-native";
import {
  markNavigationDispatched,
  startUiDelayMonitoring,
  stopUiDelayMonitoring,
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

  describe( "heartbeat", ( ) => {
    // Runs the heartbeat once with the clock at the given time, i.e. an
    // interval that took ( at - previous at ) instead of the scheduled 500ms.
    const tickAt = at => {
      Date.now.mockReturnValue( at );
      jest.advanceTimersByTime( 500 );
    };

    beforeEach( ( ) => {
      // Faking Date as well would replace the Date.now spy the outer beforeEach
      // installed, and tickAt drives the clock through that spy.
      jest.useFakeTimers( { doNotFake: ["Date"] } );
      AppState.currentState = "active";
      jest.spyOn( AppState, "addEventListener" ).mockReturnValue( { remove: jest.fn( ) } );
    } );

    afterEach( ( ) => {
      stopUiDelayMonitoring( );
      jest.useRealTimers( );
    } );

    it( "reports stalls it was still holding when the burst ended", ( ) => {
      Date.now.mockReturnValue( 1_000_000 );
      startUiDelayMonitoring( );

      // The first stall is reported immediately; the rest of the burst is
      // summarized so one slow operation doesn't emit a line per tick.
      tickAt( 1_002_500 );
      expect( mockInfoWithExtra ).toHaveBeenCalledWith( "ui_stall", expect.any( Object ) );
      mockInfoWithExtra.mockClear( );

      tickAt( 1_004_000 );
      expect( mockInfoWithExtra ).not.toHaveBeenCalled( );

      // Nothing stalls again, so only a flush on a quiet tick can report it.
      for ( let at = 1_004_500; at <= 1_034_500; at += 500 ) { tickAt( at ); }

      expect( mockInfoWithExtra ).toHaveBeenCalledWith( "ui_stall", expect.objectContaining( {
        stalledMs: 1_000,
        stallCount: 1,
        screen: "MyObservations",
      } ) );
    } );

    it( "logs a freeze too long to be ordinary jitter", ( ) => {
      Date.now.mockReturnValue( 2_000_000 );
      startUiDelayMonitoring( );

      tickAt( 2_045_000 );

      expect( mockInfoWithExtra ).toHaveBeenCalledWith( "ui_hang", expect.objectContaining( {
        stalledMs: 44_500,
        screen: "MyObservations",
        mayBeSuspension: true,
      } ) );
    } );
  } );
} );
