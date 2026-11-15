import { exists } from "@dr.pogodin/react-native-fs";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import useAudioIdHistory from "components/AudioId/audioIdHistory";
import { useClipSpan } from "components/AudioId/ClipTrimmer";

const sp = { name: "Turdus migratorius", commonName: "American Robin", taxonId: 12727 };

describe( "useClipSpan", ( ) => {
  beforeEach( ( ) => {
    jest.mocked( exists ).mockResolvedValue( true );
  } );

  it( "saves a changed trim, and starts from it when the clip is opened again", async ( ) => {
    const clip = useAudioIdHistory.getState( ).addClip( sp, 0.9, { call: [5, 10] } );
    const { result, unmount } = renderHook( ( ) => useClipSpan( clip.id, clip.time, clip.call ) );
    await waitFor( ( ) => expect( result.current.trim ).toEqual( [5, 10] ) );
    act( ( ) => result.current.setTrim( [6, 9] ) );
    unmount( );
    const saved = useAudioIdHistory.getState( ).clips[clip.id];
    expect( saved.trim ).toEqual( [6, 9] );

    const { result: reopened } = renderHook( ( ) => useClipSpan(
      saved.id,
      saved.time,
      saved.call,
      saved.duration,
      saved.trim,
    ) );
    await waitFor( ( ) => expect( reopened.current.trim ).toEqual( [6, 9] ) );
  } );
} );
