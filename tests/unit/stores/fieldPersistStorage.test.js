import { MMKV } from "react-native-mmkv";
import createFieldStorage from "stores/fieldPersistStorage";

describe( "fieldPersistStorage", ( ) => {
  let mmkv;
  let fieldStorage;

  beforeEach( ( ) => {
    mmkv = new MMKV( { id: `field-storage-${Math.random( )}` } );
    fieldStorage = createFieldStorage( mmkv );
  } );

  it( "moves a legacy blob into one key per field", ( ) => {
    const value = { state: { a: 1, b: { c: 2 } }, version: 0 };
    mmkv.set( "store", JSON.stringify( value ) );

    expect( fieldStorage.getItem( "store" ) ).toEqual( value );
    expect( mmkv.getString( "store" ) ).toBeUndefined( );
    expect( JSON.parse( mmkv.getString( "store.b" ) ) ).toEqual( { c: 2 } );
    expect( fieldStorage.getItem( "store" ) ).toEqual( value );
  } );

  it( "writes only fields that changed", ( ) => {
    const list = [1, 2];
    fieldStorage.setItem( "store", { state: { a: 1, list }, version: 0 } );
    const set = jest.spyOn( mmkv, "set" );

    // A rebuilt array with the same elements is unchanged
    fieldStorage.setItem( "store", { state: { a: 1, list: [...list] }, version: 0 } );
    expect( set ).not.toHaveBeenCalled( );

    fieldStorage.setItem( "store", { state: { a: 2, list }, version: 0 } );
    expect( set ).toHaveBeenCalledTimes( 1 );
    expect( set ).toHaveBeenCalledWith( "store.a", "2" );
  } );

  it( "skips rewriting a field rehydrated as an equal copy", ( ) => {
    fieldStorage.setItem( "store", { state: { b: { c: 2 } }, version: 0 } );
    const rehydrated = createFieldStorage( mmkv );
    rehydrated.getItem( "store" );
    const set = jest.spyOn( mmkv, "set" );

    rehydrated.setItem( "store", { state: { b: { c: 2 } }, version: 0 } );
    expect( set ).not.toHaveBeenCalled( );
  } );

  it( "removes every field", ( ) => {
    fieldStorage.setItem( "store", { state: { a: 1, b: 2 }, version: 0 } );
    fieldStorage.removeItem( "store" );
    expect( fieldStorage.getItem( "store" ) ).toBeNull( );
  } );
} );
