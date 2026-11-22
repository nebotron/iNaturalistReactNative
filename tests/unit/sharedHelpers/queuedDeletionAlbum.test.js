import addPhotosToImportedAlbum, {
  removePhotosFromImportedAlbum,
} from "sharedHelpers/importedPhotoAlbum";
import {
  requestAlbumRefile,
  setQueuedDeletionAlbumSource,
} from "sharedHelpers/queuedDeletionAlbum";
import { addRemovedGroupPhotoUris } from "sharedHelpers/removedGroupPhotoUris";
import { restoreFavedDevicePhotos } from "sharedHelpers/restoreFavedDevicePhotos";
import { saveFavedStagedPhotos, startUsbStagingClocks } from "sharedHelpers/usbStaging";
import { onCachedFavesChanged, readCachedObservation } from "sharedHelpers/userObservationsCache";

jest.mock( "sharedHelpers/importedPhotoAlbum", ( ) => ( {
  __esModule: true,
  default: jest.fn( async ( ) => ( { added: 1, alreadyIn: 0 } ) ),
  removePhotosFromImportedAlbum: jest.fn( async ( ) => true ),
} ) );

jest.mock( "sharedHelpers/restoreFavedDevicePhotos", ( ) => ( {
  readRestoredUris: ( ) => ( {} ),
  restoredUriFor: ( uri, restored ) => restored[uri],
  restoreFavedDevicePhotos: jest.fn( async ( ) => ( { saved: [], failed: false } ) ),
} ) );

jest.mock( "sharedHelpers/usbStaging", ( ) => ( {
  expireUsbStaging: jest.fn( ),
  libraryUriForDevicePhoto: uri => uri,
  readSavedStagedUris: ( ) => ( {} ),
  saveFavedStagedPhotos: jest.fn( async ( ) => ( { saved: [], refused: false } ) ),
  startUsbStagingClocks: jest.fn( ),
} ) );

jest.mock( "sharedHelpers/userObservationsCache", ( ) => ( {
  onCachedFavesChanged: jest.fn( ( ) => ( ) => undefined ),
  readCachedObservation: jest.fn( ( ) => undefined ),
} ) );

jest.mock( "sharedHelpers/promptDeleteOriginalDevicePhotos", ( ) => ( {
  enqueuePhotoLibraryWrite: task => task( ( ) => undefined ),
} ) );

jest.mock( "sharedHelpers/uiDelayTracker", ( ) => ( { trackUiWork: jest.fn( ) } ) );

const makeObservation = ( uuid, { faved = false, uris = [] } = {} ) => ( {
  uuid,
  isValid: ( ) => true,
  votes: faved
    ? [{ vote_scope: null }]
    : [],
  observationPhotos: uris.map( uri => ( { originalDevicePhotoUri: uri, photo: {} } ) ),
} );

// Answers lookups by uuid and the queries the album makes, and nothing else:
// walking every observation would throw here.
const makeRealm = observations => ( {
  isClosed: false,
  objectForPrimaryKey: ( _type, uuid ) => observations.find( obs => obs.uuid === uuid ),
  objects: ( ) => ( {
    filtered: ( query, except, uris ) => observations.filter( obs => obs.uuid !== except
      && obs.observationPhotos.some( p => uris.includes( p.originalDevicePhotoUri ) ) ),
  } ),
} );

// Past the debounce, and through the refile's awaits
const settle = async ( ) => {
  await jest.advanceTimersByTimeAsync( 2000 );
  await jest.advanceTimersByTimeAsync( 0 );
};

const urisPassedTo = mockFn => mockFn.mock.calls.flatMap( ( [uris] ) => uris );

describe( "queuedDeletionAlbum", ( ) => {
  beforeEach( ( ) => {
    jest.useFakeTimers( );
    jest.clearAllMocks( );
  } );
  afterEach( ( ) => { jest.useRealTimers( ); } );

  it( "files and unfiles only the photos of the observations that changed", async ( ) => {
    setQueuedDeletionAlbumSource( makeRealm( [
      makeObservation( "a", { uris: ["ph://A"] } ),
      makeObservation( "b", { faved: true, uris: ["ph://B"] } ),
      makeObservation( "c", { uris: ["ph://C"] } ),
    ] ) );
    requestAlbumRefile( ["a", "b"] );
    await settle( );
    expect( urisPassedTo( addPhotosToImportedAlbum ) ).toEqual( ["ph://A"] );
    expect( urisPassedTo( removePhotosFromImportedAlbum ) ).toEqual( ["ph://B"] );
  } );

  it( "writes nothing for a photo already where it belongs", async ( ) => {
    setQueuedDeletionAlbumSource( makeRealm( [makeObservation( "d", { uris: ["ph://D"] } )] ) );
    requestAlbumRefile( ["d"] );
    await settle( );
    jest.clearAllMocks( );
    requestAlbumRefile( ["d"] );
    await settle( );
    expect( addPhotosToImportedAlbum ).not.toHaveBeenCalled( );
  } );

  it( "keeps a photo out that a faved observation also holds", async ( ) => {
    setQueuedDeletionAlbumSource( makeRealm( [
      makeObservation( "e", { uris: ["ph://E", "ph://SHARED"] } ),
      makeObservation( "f", { faved: true, uris: ["ph://SHARED"] } ),
    ] ) );
    requestAlbumRefile( ["e"] );
    await settle( );
    expect( urisPassedTo( addPhotosToImportedAlbum ) ).toEqual( ["ph://E"] );
  } );

  it( "takes out and saves the photos of an observation faved elsewhere", async ( ) => {
    // Realm's votes say unfaved; the cache knows better
    readCachedObservation.mockImplementation( ( _user, uuid ) => (
      uuid === "g"
        ? { uuid, faved: true }
        : undefined
    ) );
    setQueuedDeletionAlbumSource( makeRealm( [makeObservation( "g", { uris: ["ph://G"] } )] ), 1 );
    const [[favesChanged]] = onCachedFavesChanged.mock.calls;
    favesChanged( ["g"] );
    await settle( );
    readCachedObservation.mockReset( );
    expect( urisPassedTo( removePhotosFromImportedAlbum ) ).toEqual( ["ph://G"] );
    expect( saveFavedStagedPhotos ).toHaveBeenCalledWith( [{ uri: "ph://G", crop: undefined }] );
    expect( restoreFavedDevicePhotos.mock.calls[0][1] ).toEqual( ["ph://G"] );
  } );

  it( "tries a refused write again at the next launch", async ( ) => {
    const realm = makeRealm( [makeObservation( "h", { uris: ["ph://H"] } )] );
    setQueuedDeletionAlbumSource( realm );
    addPhotosToImportedAlbum.mockResolvedValueOnce( null );
    requestAlbumRefile( ["h"] );
    await settle( );
    jest.clearAllMocks( );

    setQueuedDeletionAlbumSource( realm );
    await settle( );
    expect( urisPassedTo( addPhotosToImportedAlbum ) ).toEqual( ["ph://H"] );
  } );

  it( "files a removed photo, and starts its staged copy's retention", async ( ) => {
    setQueuedDeletionAlbumSource( makeRealm( [] ) );
    addRemovedGroupPhotoUris( ["ph://REMOVED"] );
    await settle( );
    expect( urisPassedTo( addPhotosToImportedAlbum ) ).toEqual( ["ph://REMOVED"] );
    expect( startUsbStagingClocks ).toHaveBeenCalledWith( ["ph://REMOVED"] );
  } );
} );
