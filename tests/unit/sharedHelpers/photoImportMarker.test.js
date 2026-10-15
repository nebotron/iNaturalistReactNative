import {
  clearPhotoImportMarker,
  markPhotoImportStarted,
  takeUnfinishedPhotoImport,
  updatePhotoImportProgress,
} from "sharedHelpers/photoImportMarker";

// The Aug 6 log has an import of 48 photos that reported 9 settled at 30s, six
// stalled exports at 134s, and then nothing at all — no "settled" line, no
// further stall, a cold pickup twelve minutes later. Every log line is a
// network POST, so a run that dies takes its last lines with it. This marker
// is MMKV, so it survives the death it is measuring.
describe( "photoImportMarker", ( ) => {
  beforeEach( ( ) => clearPhotoImportMarker( ) );

  it( "says nothing when there was no import", ( ) => {
    expect( takeUnfinishedPhotoImport( ) ).toBeNull( );
  } );

  it( "says nothing about an import that finished", ( ) => {
    markPhotoImportStarted( 48 );
    updatePhotoImportProgress( 48, 0 );
    clearPhotoImportMarker( );

    expect( takeUnfinishedPhotoImport( ) ).toBeNull( );
  } );

  it( "reports how far an import that vanished had got", ( ) => {
    markPhotoImportStarted( 48 );
    updatePhotoImportProgress( 9, 6 );

    const unfinished = takeUnfinishedPhotoImport( );
    expect( unfinished ).toMatchObject( { selected: 48, settled: 9, failed: 6 } );
    expect( unfinished.startedAt ).toBeLessThanOrEqual( Date.now( ) );
  } );

  it( "reports one abandoned import once", ( ) => {
    markPhotoImportStarted( 48 );

    expect( takeUnfinishedPhotoImport( ) ).not.toBeNull( );
    expect( takeUnfinishedPhotoImport( ) ).toBeNull( );
  } );

  it( "ignores progress reported outside an import", ( ) => {
    updatePhotoImportProgress( 3, 0 );

    expect( takeUnfinishedPhotoImport( ) ).toBeNull( );
  } );
} );
