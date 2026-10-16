import type { MMKV } from "react-native-mmkv";
import type { PersistStorage, StorageValue } from "zustand/middleware";

// One MMKV key per persisted field ("<name>.<field>"), each rewritten only when
// that field changes. persist calls setItem after every set( ), including the
// many that touch nothing persisted (scroll offsets, upload progress), and it
// used to serialize and rewrite every persisted field each time.
const isPlainObject = ( value: unknown ): value is Record<string, unknown> => !!value
  && Object.getPrototypeOf( value ) === Object.prototype;
// partialize builds fresh wrapper objects and arrays, so compare one level in
const shallowEqual = ( a: unknown, b: unknown ) => {
  if ( a === b ) return true;
  if ( Array.isArray( a ) && Array.isArray( b ) ) {
    return a.length === b.length && a.every( ( v, i ) => v === b[i] );
  }
  if ( isPlainObject( a ) && isPlainObject( b ) ) {
    const keys = Object.keys( a );
    return keys.length === Object.keys( b ).length && keys.every( k => a[k] === b[k] );
  }
  return false;
};

const createFieldStorage = <S extends object>( storage: MMKV ): PersistStorage<S> => {
  // What each field's key holds, so an unchanged field costs no write, and an
  // equal but rebuilt one (as after rehydration) costs one stringify
  const written = new Map<string, { value: unknown; json: string | undefined }>( );
  let writtenVersion: number | undefined;
  const keysOf = ( name: string ) => storage.getAllKeys( )
    .filter( key => key.startsWith( `${name}.` ) );
  const writeField = ( name: string, field: string, value: unknown ) => {
    const last = written.get( field );
    if ( last && shallowEqual( last.value, value ) ) return;
    const json = value === undefined
      ? undefined
      : JSON.stringify( value );
    written.set( field, { value, json } );
    if ( last && last.json === json ) return;
    if ( json === undefined ) {
      storage.delete( `${name}.${field}` );
    } else {
      storage.set( `${name}.${field}`, json );
    }
  };
  return {
    getItem: name => {
      // Before fields had keys of their own, everything was one JSON blob
      const legacy = storage.getString( name );
      if ( legacy ) {
        storage.delete( name );
        const { state, version } = JSON.parse( legacy ) as StorageValue<S>;
        Object.entries( state ).forEach( ( [field, value] ) => writeField( name, field, value ) );
        writtenVersion = version ?? 0;
        storage.set( `${name}.`, writtenVersion );
        return { state, version };
      }
      const keys = keysOf( name );
      if ( keys.length === 0 ) return null;
      const state: Record<string, unknown> = {};
      keys.forEach( key => {
        const field = key.slice( name.length + 1 );
        if ( !field ) return;
        const json = storage.getString( key );
        if ( json === undefined ) return;
        state[field] = JSON.parse( json );
        written.set( field, { value: state[field], json } );
      } );
      writtenVersion = storage.getNumber( `${name}.` );
      return { state: state as S, version: writtenVersion };
    },
    setItem: ( name, { state, version } ) => {
      Object.entries( state ).forEach( ( [field, value] ) => writeField( name, field, value ) );
      if ( writtenVersion !== ( version ?? 0 ) ) {
        writtenVersion = version ?? 0;
        storage.set( `${name}.`, writtenVersion );
      }
    },
    removeItem: name => {
      keysOf( name ).forEach( key => storage.delete( key ) );
      written.clear( );
      writtenVersion = undefined;
    },
  };
};

export default createFieldStorage;
