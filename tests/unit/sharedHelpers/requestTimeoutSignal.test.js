import { createRequestTimeoutSignal } from "sharedHelpers/logging";

describe( "createRequestTimeoutSignal", ( ) => {
  it( "aborts when the parent signal does", ( ) => {
    const parent = new AbortController( );
    const { signal, clear } = createRequestTimeoutSignal( parent.signal );
    expect( signal.aborted ).toBe( false );
    parent.abort( );
    expect( signal.aborted ).toBe( true );
    clear( );
  } );

  it( "starts aborted when the parent already is", ( ) => {
    const parent = new AbortController( );
    parent.abort( );
    const { signal, clear } = createRequestTimeoutSignal( parent.signal );
    expect( signal.aborted ).toBe( true );
    clear( );
  } );

  it( "stops following the parent once cleared", ( ) => {
    const parent = new AbortController( );
    const { signal, clear } = createRequestTimeoutSignal( parent.signal );
    clear( );
    parent.abort( );
    expect( signal.aborted ).toBe( false );
  } );
} );
