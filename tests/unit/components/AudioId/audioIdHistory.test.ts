import { readFile, unlink } from "@dr.pogodin/react-native-fs";
import useAudioIdHistory, {
  clipPath, expireOldClips, NO_SPECIES, retryLabelUploads,
} from "components/AudioId/audioIdHistory";
import Config from "react-native-config";

jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  isCurrentUser: jest.fn( async ( ) => true ),
} ) );

const sp = { name: "Turdus migratorius", commonName: "American Robin", taxonId: 12727 };
const DAY_MS = 24 * 60 * 60 * 1000;

const mockFetch = jest.fn( );
const labelPuts = ( id: string ) => mockFetch.mock.calls
  .filter( ( [url] ) => url === `https://fb.test/audio_id_labels/${id}.json` );

beforeAll( ( ) => {
  ( Config as Record<string, string> ).CROP_LOG_FIREBASE_URL = "https://fb.test";
  global.fetch = mockFetch;
} );

beforeEach( ( ) => {
  mockFetch.mockReset( );
  mockFetch.mockResolvedValue( { ok: true } );
  ( unlink as jest.Mock ).mockClear( );
  ( readFile as jest.Mock ).mockResolvedValue( "audio" );
} );

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

describe( "deleting a labeled clip", ( ) => {
  it( "doesn't remove its label from Firebase", async ( ) => {
    const { addClip, labelClip, deleteClip } = useAudioIdHistory.getState( );
    const clip = addClip( sp, 0.9 );
    await labelClip( clip.id, sp.taxonId, sp.name );
    expect( useAudioIdHistory.getState( ).clips[clip.id].label?.synced ).toBe( true );
    deleteClip( clip.id );
    await retryLabelUploads( );
    expect( mockFetch.mock.calls.some( ( [, init] ) => init?.method === "DELETE" ) ).toBe( false );
    expect( labelPuts( clip.id ) ).toHaveLength( 1 );
  } );

  it( "keeps a label Firebase didn't get, with its audio, until it does", async ( ) => {
    const { addClip, labelClip, deleteClip } = useAudioIdHistory.getState( );
    const clip = addClip( sp, 0.9 );
    mockFetch.mockResolvedValue( { ok: false } );
    await labelClip( clip.id, undefined, null );
    deleteClip( clip.id );
    await new Promise( setImmediate );
    expect( unlink ).not.toHaveBeenCalledWith( clipPath( clip.id ) );

    mockFetch.mockResolvedValue( { ok: true } );
    await retryLabelUploads( );
    const body = JSON.parse( labelPuts( clip.id ).at( -1 )[1].body );
    expect( body.correct ).toBe( false );
    expect( unlink ).toHaveBeenCalledWith( clipPath( clip.id ) );

    // Uploaded; not sent again
    await retryLabelUploads( );
    expect( labelPuts( clip.id ) ).toHaveLength( 2 );
  } );

  it( "keeps a label deleted while uploading until the upload is done", async ( ) => {
    const { addClip, labelClip, deleteClip } = useAudioIdHistory.getState( );
    const clip = addClip( sp, 0.9 );
    const labeling = labelClip( clip.id, sp.taxonId, sp.name );
    deleteClip( clip.id );
    await labeling;
    expect( labelPuts( clip.id ) ).toHaveLength( 1 );
    expect( unlink ).toHaveBeenCalledWith( clipPath( clip.id ) );
    await retryLabelUploads( );
    expect( labelPuts( clip.id ) ).toHaveLength( 1 );
  } );
} );
