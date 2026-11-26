import SPECIES from "components/AudioId/audioIdSpecies.json";
import { NativeModules } from "react-native";

const trimClip = jest.fn( ( _path, _from, _to, out ) => Promise.resolve( out ) );
const scoreSound = jest.fn( ( ) => Promise.resolve( [0.42] ) );
NativeModules.AudioBirdId = {
  trimClip, scoreSound, addListener: jest.fn( ), removeListeners: jest.fn( ),
};
// The session reads the native module when it loads, so it's required after.
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { scoreTrim } = require( "components/AudioId/audioIdSession" );

describe( "scoreTrim", ( ) => {
  const [name, commonName, taxonId] = SPECIES[3] as [string, string, number];

  it( "scores the trimmed stretch, as Identify will, for the species' model output", async ( ) => {
    const score = await scoreTrim( "/clips/a-15s.m4a", [4.5, 6.5], { name, commonName, taxonId } );
    expect( score ).toBe( 0.42 );
    const out = trimClip.mock.calls[0][3];
    expect( trimClip ).toHaveBeenCalledWith( "/clips/a-15s.m4a", 4.5, 6.5, out );
    expect( scoreSound ).toHaveBeenCalledWith( out, [3] );
  } );

  it( "gives no score for a species the model no longer has", async ( ) => {
    scoreSound.mockClear( );
    const score = await scoreTrim( "/clips/a-15s.m4a", [0, 2], {
      name: "Nonexistent species", commonName: "", taxonId: -1,
    } );
    expect( score ).toBeNull( );
    expect( scoreSound ).not.toHaveBeenCalled( );
  } );
} );
