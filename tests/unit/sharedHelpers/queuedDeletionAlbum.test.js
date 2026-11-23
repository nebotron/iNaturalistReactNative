// Instances with the same id share their values, as on a device
const mockStores = new Map( );
jest.mock( "react-native-mmkv", ( ) => ( {
  MMKV: class {
    constructor( { id } = { id: "mmkv.default" } ) {
      if ( !mockStores.has( id ) ) mockStores.set( id, new Map( ) );
      this.values = mockStores.get( id );
    }

    getString( key ) {
      const value = this.values.get( key );
      return typeof value === "string"
        ? value
        : undefined;
    }

    getNumber( key ) {
      const value = this.values.get( key );
      return typeof value === "number"
        ? value
        : undefined;
    }

    set( key, value ) { this.values.set( key, value ); }

    delete( key ) { this.values.delete( key ); }

    getAllKeys( ) { return [...this.values.keys( )]; }
  },
} ) );

const mockAdd = jest.fn( async ( ) => ( { added: 1, alreadyIn: 0 } ) );
const mockRemove = jest.fn( async ( ) => true );
jest.mock( "sharedHelpers/importedPhotoAlbum", ( ) => ( {
  __esModule: true,
  default: ( ...args ) => mockAdd( ...args ),
  removePhotosFromImportedAlbum: ( ...args ) => mockRemove( ...args ),
} ) );

jest.mock( "sharedHelpers/promptDeleteOriginalDevicePhotos", ( ) => ( {
  enqueuePhotoLibraryWrite: task => task( ( ) => undefined ),
} ) );

const mockRestore = jest.fn( async ( ) => ( { saved: [], failed: false, retry: [] } ) );
jest.mock( "sharedHelpers/restoreFavedDevicePhotos", ( ) => ( {
  restoredUriFor: ( ) => undefined,
  restoreFavedDevicePhotos: ( ...args ) => mockRestore( ...args ),
} ) );

const mockStartClocks = jest.fn( );
jest.mock( "sharedHelpers/usbStaging", ( ) => ( {
  devicePhotoKey: uri => uri,
  expireStagedPhotos: async ( ) => undefined,
  isUnsavedStagedPhoto: ( ) => false,
  libraryUriForDevicePhoto: uri => uri,
  saveFavedStagedPhotos: async ( ) => ( { saved: [], failed: [] } ),
  startStagingClocks: ( ...args ) => mockStartClocks( ...args ),
} ) );

jest.mock( "sharedHelpers/duplicateUploadedDevicePhotos", ( ) => ( {
  getDevicePhotoUrisFromObservation: observation => observation.observationPhotos
    .map( op => op.originalDevicePhotoUri ),
  recordUploadedDevicePhotoUris: jest.fn( ),
} ) );

const mockRemovedListeners = new Set( );
let mockRemovedUris = [];
jest.mock( "sharedHelpers/removedGroupPhotoUris", ( ) => ( {
  getRemovedGroupPhotoUris: ( ) => mockRemovedUris,
  onRemovedGroupPhotoUris: listener => {
    mockRemovedListeners.add( listener );
    return ( ) => mockRemovedListeners.delete( listener );
  },
} ) );

const observation = ( uuid, uris, faved = false ) => ( {
  uuid,
  votes: faved
    ? [{ vote_scope: null }]
    : [],
  observationPhotos: uris.map( uri => ( { originalDevicePhotoUri: uri } ) ),
  isValid: ( ) => true,
} );

const realmWith = observations => ( {
  isClosed: false,
  objects: ( ) => observations,
  objectForPrimaryKey: ( type, uuid ) => observations.find( o => o.uuid === uuid ),
} );

const flushPromises = async ( ) => {
  for ( let i = 0; i < 20; i += 1 ) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise( resolve => { setImmediate( resolve ); } );
  }
};

// Lets the debounce run out and the album writes settle
const settle = async ( ) => {
  jest.advanceTimersByTime( 2000 );
  await flushPromises( );
};

let album;
const load = ( ) => {
  jest.isolateModules( ( ) => {
    album = jest.requireActual( "sharedHelpers/queuedDeletionAlbum" );
  } );
};

beforeEach( ( ) => {
  jest.useFakeTimers( { doNotFake: ["setImmediate", "nextTick"] } );
  mockStores.clear( );
  mockRemovedListeners.clear( );
  mockRemovedUris = [];
  mockAdd.mockClear( );
  mockRemove.mockClear( );
  mockRestore.mockClear( );
  mockStartClocks.mockClear( );
  load( );
} );
afterEach( ( ) => { jest.useRealTimers( ); } );

describe( "queuedDeletionAlbum", ( ) => {
  it( "files unfaved observations' photos and unfiles faved ones on first launch", async ( ) => {
    mockRemovedUris = ["ph://REMOVED"];
    const realm = realmWith( [
      observation( "a", ["ph://A"] ),
      observation( "b", ["ph://B"], true ),
    ] );
    album.setQueuedDeletionAlbumSource( realm );
    await settle( );

    expect( mockAdd ).toHaveBeenCalledWith( expect.arrayContaining( ["ph://A", "ph://REMOVED"] ) );
    expect( mockAdd.mock.calls[0][0] ).not.toContain( "ph://B" );
    expect( mockRemove ).toHaveBeenCalledWith( ["ph://B"] );
    expect( mockRestore.mock.calls[0][1] ).toEqual( ["ph://B"] );
  } );

  it( "touches only the observation that changed", async ( ) => {
    const observations = [
      observation( "a", ["ph://A"] ),
      observation( "b", ["ph://B"] ),
    ];
    album.setQueuedDeletionAlbumSource( realmWith( observations ) );
    await settle( );
    mockAdd.mockClear( );

    // A new import
    observations.push( observation( "c", ["ph://C"] ) );
    album.onObservationsChanged( observations, { insertions: [2], newModifications: [] } );
    await settle( );
    expect( mockAdd ).toHaveBeenCalledTimes( 1 );
    expect( mockAdd ).toHaveBeenCalledWith( ["ph://C"] );

    // Faved
    observations[0] = observation( "a", ["ph://A"], true );
    album.onObservationsChanged( observations, { insertions: [], newModifications: [0] } );
    await settle( );
    expect( mockRemove ).toHaveBeenCalledWith( ["ph://A"] );

    // Unfaved again
    mockAdd.mockClear( );
    observations[0] = observation( "a", ["ph://A"] );
    album.onObservationsChanged( observations, { insertions: [], newModifications: [0] } );
    await settle( );
    expect( mockAdd ).toHaveBeenCalledWith( ["ph://A"] );

    // A write that changes nothing the album uses
    mockAdd.mockClear( );
    mockRemove.mockClear( );
    album.onObservationsChanged( observations, { insertions: [], newModifications: [1] } );
    await settle( );
    expect( mockAdd ).not.toHaveBeenCalled( );
    expect( mockRemove ).not.toHaveBeenCalled( );
  } );

  it( "keeps a change the library refused, and sends it again on the next flush", async ( ) => {
    const observations = [observation( "a", ["ph://A"] )];
    mockAdd.mockResolvedValueOnce( null );
    album.setQueuedDeletionAlbumSource( realmWith( observations ) );
    await settle( );
    expect( mockAdd ).toHaveBeenCalledTimes( 1 );

    album.requestQueuedDeletionAlbumSync( );
    await settle( );
    expect( mockAdd ).toHaveBeenCalledTimes( 2 );
    expect( mockAdd ).toHaveBeenLastCalledWith( ["ph://A"] );

    // Taken: nothing left to send.
    album.requestQueuedDeletionAlbumSync( );
    await settle( );
    expect( mockAdd ).toHaveBeenCalledTimes( 2 );
  } );

  it( "survives a restart with changes still queued", async ( ) => {
    mockAdd.mockResolvedValueOnce( null );
    album.setQueuedDeletionAlbumSource( realmWith( [observation( "a", ["ph://A"] )] ) );
    await settle( );

    load( );
    mockAdd.mockClear( );
    album.setQueuedDeletionAlbumSource( realmWith( [observation( "a", ["ph://A"] )] ) );
    await settle( );
    expect( mockAdd ).toHaveBeenCalledWith( ["ph://A"] );
  } );

  it( "files a removed photo and starts its staging clock", async ( ) => {
    album.setQueuedDeletionAlbumSource( realmWith( [] ) );
    await settle( );
    mockRemovedListeners.forEach( listener => listener( ["ph://GONE"] ) );
    expect( mockStartClocks ).toHaveBeenCalledWith( ["ph://GONE"] );
    album.requestQueuedDeletionAlbumSync( );
    await settle( );
    expect( mockAdd ).toHaveBeenCalledWith( ["ph://GONE"] );
  } );
} );
