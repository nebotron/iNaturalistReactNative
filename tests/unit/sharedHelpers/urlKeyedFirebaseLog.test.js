import { createUrlKeyedFirebaseLog } from "sharedHelpers/urlKeyedFirebaseLog";
import zustandMMKVBackingStorage from "stores/zustandMMKVBackingStorage";

jest.mock( "react-native-config", ( ) => ( { CROP_LOG_FIREBASE_URL: "https://log.example" } ) );

const DAY_MS = 24 * 60 * 60 * 1000;
const URL = "https://example.com/photos/1/large.jpg";

const createLog = storageKey => createUrlKeyedFirebaseLog( {
  storageKey,
  firebasePath: "test_log",
  shouldSync: url => url.startsWith( "http" ),
  toFirebaseEntry: ( url, value ) => ( { url, value } ),
} );

describe( "urlKeyedFirebaseLog", ( ) => {
  beforeEach( ( ) => {
    global.fetch = jest.fn( ( ) => Promise.resolve( { ok: true } ) );
  } );

  afterEach( ( ) => {
    jest.useRealTimers( );
  } );

  it( "moves a legacy blob out of the default store", ( ) => {
    zustandMMKVBackingStorage.set( "legacyLog", JSON.stringify( { [URL]: 3 } ) );

    const log = createLog( "legacyLog" );

    expect( log.get( URL ) ).toEqual( 3 );
    expect( zustandMMKVBackingStorage.getString( "legacyLog" ) ).toBeUndefined( );
  } );

  it( "retries an entry Firebase never got", async ( ) => {
    global.fetch = jest.fn( ( ) => Promise.reject( new Error( "offline" ) ) );
    const log = createLog( "retryLog" );
    await log.save( URL, 1 );

    global.fetch = jest.fn( ( ) => Promise.resolve( { ok: true } ) );
    await log.maintain( );

    expect( global.fetch ).toHaveBeenCalledTimes( 1 );
    await log.maintain( );
    expect( global.fetch ).toHaveBeenCalledTimes( 1 );
  } );

  it( "keeps a synced entry for a while, then leaves it to Firebase", async ( ) => {
    jest.useFakeTimers( { now: 0 } );
    const log = createLog( "ttlLog" );
    await log.save( URL, 1 );

    jest.setSystemTime( 29 * DAY_MS );
    await log.maintain( );
    expect( log.get( URL ) ).toEqual( 1 );

    jest.setSystemTime( 31 * DAY_MS );
    await log.maintain( );
    expect( log.get( URL ) ).toBeNull( );
  } );
} );
