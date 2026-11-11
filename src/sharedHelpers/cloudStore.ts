import { NativeModules } from "react-native";

// The CloudKeyValueStore native module (iOS): iCloud key-value storage, plus
// documents in the app's iCloud Drive container for what's too big for it.
// Undefined on Android.
interface CloudDocument {
  status: "unavailable" | "downloading" | "ok";
  contents?: string;
}

interface CloudKeyValueStoreModule {
  isAvailable: ( ) => Promise<boolean>;
  getAll: ( ) => Promise<Record<string, string>>;
  update: ( values: Record<string, string>, removals: string[] ) => Promise<boolean>;
  readDocument: ( name: string ) => Promise<CloudDocument>;
  writeDocument: ( name: string, contents: string ) => Promise<boolean>;
}

export const cloud = ( NativeModules as { CloudKeyValueStore?: CloudKeyValueStoreModule } )
  .CloudKeyValueStore;

// FNV-1a, enough to tell a changed value from an unchanged one
/* eslint-disable no-bitwise */
export const hash = ( value: string ) => {
  let h = 0x811c9dc5;
  for ( let i = 0; i < value.length; i += 1 ) {
    h ^= value.charCodeAt( i );
    h = Math.imul( h, 0x01000193 );
  }
  return `${( h >>> 0 ).toString( 36 )}.${value.length}`;
};
/* eslint-enable no-bitwise */

export const wait = ( ms: number ) => new Promise( resolve => { setTimeout( resolve, ms ); } );
