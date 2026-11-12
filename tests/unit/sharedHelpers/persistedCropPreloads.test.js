// What survives a restart is the persisted store; each test loads
// imageCropPreload in a fresh module registry, as a new launch would.
const mockStore = new Map( );
jest.mock( "sharedHelpers/persistedPreloads", ( ) => ( {
  readPersistedPreloads: ( ) => [...mockStore.entries( )],
  writePersistedPreload: ( uri, preload ) => mockStore.set( uri, preload ),
  deletePersistedPreload: uri => mockStore.delete( uri ),
  clearPersistedPreloads: ( ) => mockStore.clear( ),
} ) );

const mockFiles = new Set( );
jest.mock( "@dr.pogodin/react-native-fs", ( ) => ( {
  CachesDirectoryPath: "caches",
  exists: async path => mockFiles.has( path ),
  mkdir: async ( ) => {},
} ) );
const mockUnlink = jest.fn( async ( ) => {} );
jest.mock( "sharedHelpers/util", ( ) => ( {
  unlink: ( ...args ) => mockUnlink( ...args ),
} ) );

const mockPrepare = jest.fn( );
jest.mock( "sharedHelpers/prepareCropSource", ( ) => ( {
  __esModule: true,
  default: ( ...args ) => mockPrepare( ...args ),
} ) );

const flush = ( ) => new Promise( resolve => { setTimeout( resolve, 0 ); } );

const launch = async ( ) => {
  let module;
  jest.isolateModules( ( ) => {
    // eslint-disable-next-line global-require
    module = require( "sharedHelpers/imageCropPreload" );
  } );
  await flush( );
  return module;
};

const cropSourcesPath = "caches/inatCropSources";
const SOURCE = "file:///photoLibraryPhotos/IMG_1.HEIC";
const DISPLAY = `file://${cropSourcesPath}/display_1.jpg`;

describe( "crop preloads across restarts", ( ) => {
  beforeEach( ( ) => {
    mockStore.clear( );
    mockFiles.clear( );
    mockUnlink.mockClear( );
    mockPrepare.mockReset( ).mockResolvedValue( {
      displayUri: DISPLAY,
      size: { w: 6000, h: 4000 },
      crop: {
        x: 0.1, y: 0.1, w: 0.5, h: 0.5,
      },
    } );
  } );

  it( "keeps a finished preload for the next launch, which doesn't prepare it again", async ( ) => {
    const first = await launch( );
    await first.enqueuePreload( SOURCE, SOURCE, null );
    expect( mockPrepare ).toHaveBeenCalledTimes( 1 );
    mockFiles.add( "/photoLibraryPhotos/IMG_1.HEIC" );
    mockFiles.add( `${cropSourcesPath}/display_1.jpg` );

    const second = await launch( );
    const result = await second.enqueuePreload( SOURCE, SOURCE, null );
    expect( mockPrepare ).toHaveBeenCalledTimes( 1 );
    expect( result.displayUri ).toBe( DISPLAY );
    expect( result.crop ).toEqual( {
      x: 0.1, y: 0.1, w: 0.5, h: 0.5,
    } );
  } );

  it( "prepares again when a kept preload's files are gone", async ( ) => {
    const first = await launch( );
    await first.enqueuePreload( SOURCE, SOURCE, null );
    // The display file was purged while the app was closed
    mockFiles.add( "/photoLibraryPhotos/IMG_1.HEIC" );

    const second = await launch( );
    await second.enqueuePreload( SOURCE, SOURCE, null );
    expect( mockPrepare ).toHaveBeenCalledTimes( 2 );
  } );

  it( "drops a preload left unused past the media cache lifetime, with its files", async ( ) => {
    mockStore.set( SOURCE, {
      savedAt: Date.now( ) - 365 * 24 * 60 * 60 * 1000,
      localUri: SOURCE,
      displayUri: DISPLAY,
      size: { w: 1, h: 1 },
      crop: {
        x: 0, y: 0, w: 1, h: 1,
      },
      timing: {},
    } );
    mockFiles.add( "/photoLibraryPhotos/IMG_1.HEIC" );
    mockFiles.add( `${cropSourcesPath}/display_1.jpg` );

    const second = await launch( );
    await flush( );
    expect( second.preloadCache.has( SOURCE ) ).toBe( false );
    expect( mockStore.has( SOURCE ) ).toBe( false );
    // Only the scratch display file; the photo itself is not the cache's
    expect( mockUnlink ).toHaveBeenCalledWith( `${cropSourcesPath}/display_1.jpg` );
    expect( mockUnlink ).not.toHaveBeenCalledWith( "/photoLibraryPhotos/IMG_1.HEIC" );
  } );

  it( "forgets a preload once its photo is cropped", async ( ) => {
    const first = await launch( );
    await first.enqueuePreload( SOURCE, SOURCE, null );
    first.releaseCropSource( SOURCE, [SOURCE, DISPLAY] );
    expect( mockStore.has( SOURCE ) ).toBe( false );
  } );
} );
