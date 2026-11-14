import { DeviceEventEmitter, NativeModules } from "react-native";

let resolveLocation: ( loc: unknown ) => void = ( ) => undefined;
jest.mock( "sharedHelpers/fetchCoarseUserLocation", ( ) => ( {
  __esModule: true,
  default: jest.fn( ( ) => new Promise( resolve => { resolveLocation = resolve; } ) ),
} ) );

const start = jest.fn( ( ) => Promise.resolve( {
  sampleRate: 48000, channels: 1, outputsGeneration: 1,
} ) );
const setOutputs = jest.fn( ( ) => Promise.resolve( 2 ) );
// Nothing likely anywhere but the first two geomodel species
const geo = jest.fn( ( ) => Promise.resolve( [1, 1, ...new Array( 20000 ).fill( 0 )] ) );
NativeModules.AudioBirdId = {
  start,
  setOutputs,
  geo,
  stop: jest.fn( ),
  saveClip: jest.fn( ( ) => Promise.resolve( "" ) ),
  timeline: jest.fn( ( ) => Promise.resolve( [] ) ),
  vibrate: jest.fn( ( ) => Promise.resolve( {} ) ),
  addListener: jest.fn( ),
  removeListeners: jest.fn( ),
};
// The session reads the native module when it loads, so it's required after.
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const useAudioIdSession = require( "components/AudioId/audioIdSession" ).default;

const flush = ( ) => new Promise( resolve => { setTimeout( resolve, 0 ); } );
const emitScores = ( outputsGeneration: number, level: number ) => DeviceEventEmitter.emit(
  "AudioBirdIdScores",
  {
    scores: { 0: 0.01 },
    level,
    windowFrame: 0,
    outputsGeneration,
    inferMs: 1,
    memMB: 1,
    error: null,
  },
);

describe( "starting Audio ID", ( ) => {
  it( "starts the mic before the user is located, then narrows the species", async ( ) => {
    const started = useAudioIdSession.getState( ).start( );
    await flush( );
    expect( start ).toHaveBeenCalled( );
    expect( useAudioIdSession.getState( ).listening ).toBe( true );
    expect( setOutputs ).not.toHaveBeenCalled( );

    // Runs before the species are settled only move the level meter
    emitScores( 1, 0.5 );
    expect( useAudioIdSession.getState( ).level ).toBe( 0.5 );
    expect( useAudioIdSession.getState( ).current ).toBeNull( );

    resolveLocation( {
      latitude: 47.6, longitude: -122.3, positional_accuracy: 1000,
    } );
    await started;
    expect( setOutputs ).toHaveBeenCalled( );
    const { setup } = useAudioIdSession.getState( );
    expect( setup.located ).toBe( true );
    expect( setOutputs ).toHaveBeenCalledWith( setup.outputs );
    expect( start.mock.calls[0][0].length ).toBeGreaterThan( setup.outputs.length );

    // A run against the outputs it started with still doesn't count
    emitScores( 1, 0.6 );
    expect( useAudioIdSession.getState( ).current ).toBeNull( );
    emitScores( 2, 0.7 );
    expect( useAudioIdSession.getState( ).current ).toEqual( { 0: 0.01 } );
    useAudioIdSession.getState( ).stop( );
  } );
} );
