import { NativeEventEmitter, NativeModules } from "react-native";

// A call peaking in the middle of the 15 s around it, in 1/3 s bins
const TIMELINE = Array.from( { length: 45 }, ( _, i ) => ( i >= 21 && i <= 24
  ? 3
  : -5 ) );
const scoreSound = jest.fn( );
const vibrate = jest.fn( ( ) => Promise.resolve( {
  allowed: true, error: null, method: "core", appState: 0,
} ) );
NativeModules.AudioBirdId = {
  saveClip: jest.fn( path => Promise.resolve( path ) ),
  timeline: jest.fn( ( ) => Promise.resolve( TIMELINE ) ),
  trimClip: jest.fn( ( _path, _from, _to, out ) => Promise.resolve( out ) ),
  scoreSound,
  vibrate,
  addListener: jest.fn( ),
  removeListeners: jest.fn( ),
};
const listeners: Record<string, ( e: unknown ) => void> = {};
jest.spyOn( NativeEventEmitter.prototype, "addListener" ).mockImplementation(
  ( name: string, handler: ( e: unknown ) => void ) => {
    listeners[name] = handler;
    return { remove: jest.fn( ) } as never;
  },
);
/* eslint-disable @typescript-eslint/no-require-imports, global-require */
// The session reads the native module when it loads, so it's required after.
const useAudioIdSession = require( "components/AudioId/audioIdSession" ).default;
const useAudioIdHistory = require( "components/AudioId/audioIdHistory" ).default;
const SPECIES = require( "components/AudioId/audioIdSpecies.json" );
/* eslint-enable @typescript-eslint/no-require-imports, global-require */

const flush = async ( ) => {
  for ( let i = 0; i < 10; i += 1 ) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve( );
  }
};

describe( "checking an Audio ID detection on its call alone", ( ) => {
  const [name, commonName, taxonId] = SPECIES[3];
  const sp = { name, commonName, taxonId };

  beforeEach( ( ) => {
    jest.useFakeTimers( );
    vibrate.mockClear( );
    useAudioIdSession.setState( { setup: { species: [sp], outputs: [3] }, heard: {} } );
    Object.keys( useAudioIdHistory.getState( ).clips )
      .forEach( id => useAudioIdHistory.getState( ).deleteClip( id ) );
  } );
  afterEach( ( ) => jest.useRealTimers( ) );

  const hear = async ( ) => {
    listeners.AudioBirdIdScores( {
      scores: { 0: 0.9 }, level: 0.1, windowFrame: 160000, inferMs: 10, memMB: 100, error: null,
    } );
    await flush( );
    jest.advanceTimersByTime( 5000 );
    await flush( );
  };

  it( "keeps the detection and alerts when the call scores high enough", async ( ) => {
    scoreSound.mockResolvedValue( [0.8] );
    await hear( );
    const clips = Object.values( useAudioIdHistory.getState( ).clips );
    expect( clips ).toHaveLength( 1 );
    expect( clips[0] ).toMatchObject( { callConfidence: 0.8, confidence: 0.9 } );
    expect( useAudioIdSession.getState( ).heard[taxonId] ).toBeDefined( );
    expect( vibrate ).toHaveBeenCalledTimes( 1 );
  } );

  it( "drops the detection without alerting when the call scores low", async ( ) => {
    scoreSound.mockResolvedValue( [0.2] );
    await hear( );
    expect( useAudioIdHistory.getState( ).clips ).toEqual( {} );
    expect( useAudioIdSession.getState( ).heard[taxonId] ).toBeUndefined( );
    expect( vibrate ).not.toHaveBeenCalled( );
  } );
} );
