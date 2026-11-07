import { NativeModules } from "react-native";
import type * as CloudBackup from "sharedHelpers/cloudBackup";

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
const cloud = {
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

const local = ( id = "default" ) => {
  mockInstances[id] ??= new Map( );
  return mockInstances[id];
};

describe( "cloudBackup", ( ) => {
  beforeEach( ( ) => {
    Object.keys( mockInstances ).forEach( id => delete mockInstances[id] );
    icloud = {};
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
    await load( ).startCloudBackup( );

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
    await backup.startCloudBackup( );

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
    await backup.startCloudBackup( );

    local( ).delete( "persisted-zustand.layout" );
    await backup.mirror( );
    expect( icloud ).toEqual( {
      "default/persisted-zustand.exploreSavedSearches": "{\"searches\":[]}",
    } );
  } );

  it( "doesn't back up a fresh install's defaults before it has restored", async ( ) => {
    const backup = load( );
    const started = backup.startCloudBackup( );
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
    const started = backup.startCloudBackup( );
    local( ).set( "currentLocale", "de" );
    await jest.advanceTimersByTimeAsync( 60 * 60 * 1000 );
    await started;

    expect( icloud ).toEqual( { "default/currentLocale": "de" } );
  } );
} );
