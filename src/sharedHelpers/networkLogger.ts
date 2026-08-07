import { useEffect, useState } from "react";

export interface NetworkLogEntry {
  id: string;
  url: string;
  method: string;
  startTime: number;
  latencyMs: number | null;
  responseBytes: number;
  cacheHit: boolean | null;
  status: number;
}

const MAX_ENTRIES = 500;
let entries: NetworkLogEntry[] = [];
const listeners = new Set<() => void>( );
let counter = 0;

function notifyListeners( ) {
  listeners.forEach( l => l( ) );
}

export function clearNetworkLog( ): void {
  entries = [];
  notifyListeners( );
}

function subscribeToNetworkLog( listener: () => void ): () => void {
  listeners.add( listener );
  return () => listeners.delete( listener );
}

export function useNetworkLog( ) {
  const [snapshot, setSnapshot] = useState( entries );

  useEffect( () => subscribeToNetworkLog( () => setSnapshot( entries ) ), [] );

  return { entries: snapshot, clearNetworkLog };
}

function addEntry( entry: NetworkLogEntry ) {
  entries = [entry, ...entries.slice( 0, MAX_ENTRIES - 1 )];
  notifyListeners( );
}

function updateEntry( id: string, updates: Partial<NetworkLogEntry> ) {
  const idx = entries.findIndex( e => e.id === id );
  if ( idx === -1 ) return;
  const next = [...entries];
  next[idx] = { ...next[idx], ...updates };
  entries = next;
  notifyListeners( );
}

function parseCacheHit( get: ( name: string ) => string | null ): boolean | null {
  const cf = get( "cf-cache-status" );
  if ( cf ) return cf.toUpperCase( ) === "HIT";
  const xc = get( "x-cache" );
  if ( xc ) return xc.toLowerCase( ).includes( "hit" );
  const age = parseInt( get( "age" ) || "0", 10 );
  if ( !Number.isNaN( age ) && age > 0 ) return true;
  return null;
}

function shouldSkip( url: string ) {
  return (
    url.startsWith( "http://localhost" )
    || url.startsWith( "http://127.0.0.1" )
    || url.includes( "debugger-proxy" )
    || url.includes( "symbolicator" )
    || url.endsWith( "/ping" )
  );
}

function resolveFetchUrl( input: Parameters<typeof fetch>[0] ): string {
  if ( typeof input === "string" ) return input;
  if ( input instanceof URL ) return input.toString( );
  return ( input as Request ).url;
}

function patchFetch( ) {
  const orig = global.fetch as typeof fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ( !orig || ( orig as any ).__nlPatched ) return;

  const patched = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = resolveFetchUrl( input );

    if ( shouldSkip( url ) ) return orig( input, init );

    const method = ( init?.method
      || ( input instanceof Request
        ? input.method
        : undefined )
      || "GET"
    ).toUpperCase( );

    const startTime = Date.now( );
    counter += 1;
    const id = `f-${counter}`;

    addEntry( {
      id,
      url,
      method,
      startTime,
      latencyMs: null,
      responseBytes: 0,
      cacheHit: null,
      status: 0,
    } );

    try {
      const response = await orig( input, init );
      const latencyMs = Date.now( ) - startTime;
      const contentLength = parseInt( response.headers.get( "content-length" ) || "0", 10 );
      const cacheHit = parseCacheHit( name => response.headers.get( name ) );
      updateEntry( id, {
        latencyMs,
        responseBytes: Number.isNaN( contentLength )
          ? 0
          : contentLength,
        cacheHit,
        status: response.status,
      } );
      return response;
    } catch ( err ) {
      updateEntry( id, { latencyMs: Date.now( ) - startTime, status: 0 } );
      throw err;
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ( patched as any ).__nlPatched = true;
  global.fetch = patched as typeof fetch;
}

function patchXHR( ) {
  const XHR = global.XMLHttpRequest;
  if ( !XHR ) return;
  const proto = XHR.prototype;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ( ( proto.send as any ).__nlPatched ) return;

  const origOpen = proto.open;
  const origSend = proto.send;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proto.open = function ( this: any, method: string, url: string, ...rest: any[] ) {
    this._nlMethod = method;
    this._nlUrl = url;
    return origOpen.apply( this, [method, url, ...rest] );
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proto.send = function ( this: any, ...args: any[] ) {
    const url: string = this._nlUrl || "";
    if ( shouldSkip( url ) ) {
      return origSend.apply( this, args );
    }

    counter += 1;
    const id = `x-${counter}`;
    const startTime = Date.now( );
    this._nlId = id;
    this._nlStart = startTime;

    addEntry( {
      id,
      url,
      method: ( this._nlMethod || "GET" ).toUpperCase( ),
      startTime,
      latencyMs: null,
      responseBytes: 0,
      cacheHit: null,
      status: 0,
    } );

    this.addEventListener( "loadend", () => {
      const latencyMs = Date.now( ) - this._nlStart;
      const contentLength = parseInt( this.getResponseHeader( "content-length" ) || "0", 10 );
      const cf = this.getResponseHeader( "cf-cache-status" );
      const xc = this.getResponseHeader( "x-cache" );
      const age = parseInt( this.getResponseHeader( "age" ) || "0", 10 );
      let cacheHit: boolean | null = null;
      if ( cf ) cacheHit = cf.toUpperCase( ) === "HIT";
      else if ( xc ) cacheHit = xc.toLowerCase( ).includes( "hit" );
      else if ( !Number.isNaN( age ) && age > 0 ) cacheHit = true;

      updateEntry( this._nlId, {
        latencyMs,
        responseBytes: Number.isNaN( contentLength )
          ? 0
          : contentLength,
        cacheHit,
        status: this.status,
      } );
    } );

    return origSend.apply( this, args );
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ( proto.send as any ).__nlPatched = true;
}

export function installNetworkInterceptor( ) {
  patchFetch( );
  patchXHR( );
}
