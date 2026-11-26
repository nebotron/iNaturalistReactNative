import { NativeModules } from "react-native";
import type * as CloudBackup from "sharedHelpers/cloudBackup";
import type * as CloudPhotoBackup from "sharedHelpers/cloudPhotoBackup";

// MMKV instances that share their contents by id, as on a device
const mockInstances: Record<string, Map<string, string | number | boolean>> = {};
jest.mock( "react-native-mmkv", ( ) => ( {
  MMKV: jest.fn( ( { id = "default" } = {} ) => {
    mockInstances[id] ??= new Map( );
    const map = mockInstances[id];
    const get = ( isType: ( v: unknown ) => boolean ) => ( key: string ) => (
      isType( map.get( key ) )
        ? map.get( key )
        : undefined
    );
    return {
      set: ( key: string, value: string | number | boolean ) => map.set( key, value ),
      getString: get( v => typeof v === "string" ),
      getNumber: get( v => typeof v === "number" ),
      getBoolean: get( v => typeof v === "boolean" ),
      contains: ( key: string ) => map.has( key ),
      delete: ( key: string ) => map.delete( key ),
      getAllKeys: ( ) => [...map.keys( )],
    };
  } ),
} ) );

const mockRehydrate = jest.fn( );
jest.mock( "stores/useStore", ( ) => ( {
  __esModule: true,
  default: { persist: { rehydrate: ( ) => mockRehydrate( ) } },
} ) );
const mockChangeLanguage = jest.fn( );
jest.mock( "sharedHelpers/changeLanguage", ( ) => ( {
  __esModule: true,
  default: ( locale: string ) => mockChangeLanguage( locale ),
} ) );

let icloud: Record<string, string>;
let documents: Record<string, string>;
const cloud = {
  readDocument: jest.fn( async ( name: string ) => ( name in documents
    ? { status: "ok", contents: documents[name] }
    : { status: "downloading" } ) ),
  writeDocument: jest.fn( async ( name: string, contents: string ) => {
    documents[name] = contents;
    return true;
  } ),
  isAvailable: jest.fn( async ( ) => true ),
  getAll: jest.fn( async ( ) => ( { ...icloud } ) ),
  update: jest.fn( async ( values: Record<string, string>, removals: string[] ) => {
    Object.assign( icloud, values );
    removals.forEach( key => delete icloud[key] );
    return true;
  } ),
};

const load = ( ) => {
  // Fresh module state each time: whether MMKV had data is read at import
  let backup: typeof CloudBackup | undefined;
  jest.isolateModules( ( ) => {
    backup = jest.requireActual<typeof CloudBackup>( "sharedHelpers/cloudBackup" );
  } );
  return backup!;
};

interface FakeObsPhoto {
  uuid: string;
  originalDevicePhotoUri?: string;
  cameraInfo?: string;
}
interface Uploaded { uri: string; uploadedAt: Date }

// The little of Realm the backup touches
const fakeRealm = ( observations: { observationPhotos: FakeObsPhoto[] }[] = [] ) => {
  const uploaded: Uploaded[] = [];
  const collection = <T, >( items: T[] ) => Object.assign(
    [...items],
    { addListener: jest.fn( ) },
  );
  return {
    isClosed: false,
    isInTransaction: false,
    beginTransaction: jest.fn( ),
    commitTransaction: jest.fn( ),
    cancelTransaction: jest.fn( ),
    uploaded,
    objects: ( name: string ) => collection<unknown>( name === "Observation"
      ? observations
      : uploaded ),
    create: jest.fn( ( _name: string, record: Uploaded ) => { uploaded.push( record ); } ),
  };
};
let realm: ReturnType<typeof fakeRealm>;
const start = ( backup: typeof CloudBackup ) => backup.startCloudBackup( realm as never );

const local = ( id = "default" ) => {
  mockInstances[id] ??= new Map( );
  return mockInstances[id];
};

describe( "cloudBackup", ( ) => {
  beforeEach( ( ) => {
    Object.keys( mockInstances ).forEach( id => delete mockInstances[id] );
    icloud = {};
    documents = {};
    realm = fakeRealm( );
    jest.clearAllMocks( );
    jest.useFakeTimers( );
    ( NativeModules as Record<string, unknown> ).CloudKeyValueStore = cloud;
  } );

  afterEach( ( ) => jest.useRealTimers( ) );

  it( "restores a fresh install from iCloud", async ( ) => {
    icloud = {
      "default/persisted-zustand.layout": "{\"isDefaultMode\":false}",
      "default/currentLocale": "fr",
      "install-data/onboardingShown": "true",
      "tunable-params/hotspotRadius": "3",
      "usb-import/importedNames": "[\"DCIM/1.JPG\"]",
      "default/lastDeletedSyncTime": "not backed up",
    };
    await start( load( ) );

    expect( local( ).get( "persisted-zustand.layout" ) ).toBe( "{\"isDefaultMode\":false}" );
    expect( local( "install-data" ).get( "onboardingShown" ) ).toBe( true );
    expect( local( "tunable-params" ).get( "hotspotRadius" ) ).toBe( 3 );
    expect( local( "usb-import" ).get( "importedNames" ) ).toBe( "[\"DCIM/1.JPG\"]" );
    expect( local( ).has( "lastDeletedSyncTime" ) ).toBe( false );
    expect( mockRehydrate ).toHaveBeenCalled( );
    expect( mockChangeLanguage ).toHaveBeenCalledWith( "fr" );
    // What it restored isn't sent straight back
    expect( cloud.update ).not.toHaveBeenCalled( );
  } );

  it( "backs up an existing install's settings, and only what changed", async ( ) => {
    local( ).set( "persisted-zustand.layout", "{\"mapType\":\"hybrid\"}" );
    local( ).set( "persisted-zustand.groupedPhotos", "[\"file:///gone.jpg\"]" );
    local( "tunable-params" ).set( "hotspotRadius", 5 );
    const backup = load( );
    await start( backup );

    expect( cloud.getAll ).not.toHaveBeenCalled( );
    expect( icloud ).toEqual( {
      "default/persisted-zustand.layout": "{\"mapType\":\"hybrid\"}",
      "tunable-params/hotspotRadius": "5",
    } );

    cloud.update.mockClear( );
    await backup.mirror( );
    expect( cloud.update ).not.toHaveBeenCalled( );

    local( "tunable-params" ).set( "hotspotRadius", 7 );
    await backup.mirror( );
    expect( cloud.update ).toHaveBeenCalledWith( { "tunable-params/hotspotRadius": "7" }, [] );
  } );

  it( "clears from iCloud what sign-out clears locally", async ( ) => {
    local( ).set( "persisted-zustand.layout", "{}" );
    local( ).set( "persisted-zustand.exploreSavedSearches", "{\"searches\":[]}" );
    const backup = load( );
    await start( backup );

    local( ).delete( "persisted-zustand.layout" );
    await backup.mirror( );
    expect( icloud ).toEqual( {
      "default/persisted-zustand.exploreSavedSearches": "{\"searches\":[]}",
    } );
  } );

  it( "doesn't back up a fresh install's defaults before it has restored", async ( ) => {
    const backup = load( );
    const started = start( backup );
    // Defaults written at launch, while iCloud hasn't downloaded yet
    local( ).set( "persisted-zustand.layout", "{\"isDefaultMode\":true}" );
    await jest.advanceTimersByTimeAsync( 15_000 );
    expect( cloud.update ).not.toHaveBeenCalled( );

    icloud = { "default/persisted-zustand.layout": "{\"isDefaultMode\":false}" };
    await jest.advanceTimersByTimeAsync( 15_000 );
    await started;

    expect( local( ).get( "persisted-zustand.layout" ) ).toBe( "{\"isDefaultMode\":false}" );
    expect( cloud.update ).not.toHaveBeenCalled( );
  } );

  it( "backs up once a fresh install has nothing in iCloud to restore", async ( ) => {
    const backup = load( );
    const started = start( backup );
    local( ).set( "currentLocale", "de" );
    await jest.advanceTimersByTimeAsync( 60 * 60 * 1000 );
    await started;

    expect( icloud ).toEqual( { "default/currentLocale": "de" } );
  } );

  describe( "device photos", ( ) => {
    const cameraInfo = JSON.stringify( { camera: "Canon EOS R5", metadata: [["Flash", "Off"]] } );

    it( "backs up which photos were imported and their camera settings", async ( ) => {
      local( ).set( "currentLocale", "en" );
      realm = fakeRealm( [{
        observationPhotos: [
          { uuid: "op-1", originalDevicePhotoUri: "ph://A/L0/001", cameraInfo },
          { uuid: "op-2" },
        ],
      }] );
      realm.uploaded.push( { uri: "ph://B/L0/001", uploadedAt: new Date( 1000 ) } );
      await start( load( ) );

      expect( JSON.parse( documents["devicePhotos.json"] ) ).toEqual( {
        v: 1,
        uploaded: [["ph://B/L0/001", 1000]],
        photos: [["op-1", "ph://A/L0/001", cameraInfo]],
      } );
      expect( icloud["devicePhotos/hash"] ).toBeDefined( );
    } );

    it( "writes no document when there's nothing to keep", async ( ) => {
      local( ).set( "currentLocale", "en" );
      await start( load( ) );
      expect( cloud.writeDocument ).not.toHaveBeenCalled( );
    } );

    it( "restores them on a fresh install, for observations still to download", async ( ) => {
      icloud = { "default/currentLocale": "en", "devicePhotos/hash": "x" };
      documents = {
        "devicePhotos.json": JSON.stringify( {
          v: 1,
          uploaded: [["ph://B/L0/001", 1000]],
          photos: [["op-1", "ph://A/L0/001", cameraInfo]],
        } ),
      };
      const backup = load( );
      await start( backup );
      await jest.advanceTimersByTimeAsync( 0 );

      expect( realm.uploaded ).toEqual( [{ uri: "ph://B/L0/001", uploadedAt: new Date( 1000 ) }] );
      let photoBackup: typeof CloudPhotoBackup | undefined;
      jest.isolateModules( ( ) => {
        photoBackup = jest.requireActual<typeof CloudPhotoBackup>(
          "sharedHelpers/cloudPhotoBackup",
        );
      } );
      expect( photoBackup?.restoredDevicePhoto( "op-1" ) ).toEqual( {
        originalDevicePhotoUri: "ph://A/L0/001",
        cameraInfo,
      } );
      expect( photoBackup?.restoredDevicePhoto( "op-2" ) ).toEqual( {} );

      // Still in the backup while its observation hasn't come back
      realm.uploaded.length = 0;
      local( ).set( "currentLocale", "fr" );
      await backup.mirror( );
      expect( JSON.parse( documents["devicePhotos.json"] ).photos )
        .toEqual( [["op-1", "ph://A/L0/001", cameraInfo]] );
    } );

    it( "doesn't back up over a document that hasn't downloaded yet", async ( ) => {
      icloud = { "default/currentLocale": "en", "devicePhotos/hash": "x" };
      realm = fakeRealm( [{ observationPhotos: [{ uuid: "op-9", cameraInfo }] }] );
      const backup = load( );
      await start( backup );
      local( ).set( "currentLocale", "fr" );
      await backup.mirror( );
      expect( cloud.writeDocument ).not.toHaveBeenCalled( );
    } );
  } );
} );
