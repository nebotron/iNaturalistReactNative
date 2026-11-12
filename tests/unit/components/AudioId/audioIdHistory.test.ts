import useAudioIdHistory, {
  expireOldClips, NO_SPECIES,
} from "components/AudioId/audioIdHistory";

const sp = { name: "Turdus migratorius", commonName: "American Robin", taxonId: 12727 };
const DAY_MS = 24 * 60 * 60 * 1000;

describe( "expireOldClips", ( ) => {
  it( "keeps clips saved by hand however old they are", ( ) => {
    const { addClip } = useAudioIdHistory.getState( );
    const old = Date.now( ) - 30 * DAY_MS;
    const detected = addClip( sp, 0.9, { time: old } );
    const saved = addClip( NO_SPECIES, 0, { time: old, manual: true, duration: 15 } );
    const recent = addClip( sp, 0.8 );
    expireOldClips( );
    const { clips } = useAudioIdHistory.getState( );
    expect( clips[detected.id] ).toBeUndefined( );
    expect( clips[saved.id] ).toEqual( saved );
    expect( clips[recent.id] ).toEqual( recent );
  } );
} );
