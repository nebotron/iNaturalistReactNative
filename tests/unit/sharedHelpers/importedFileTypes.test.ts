import {
  fileExtension,
  summarizeTypes,
  totalMegabytes,
} from "sharedHelpers/importedFileTypes";

describe( "fileExtension", ( ) => {
  it( "reads the extension from a path or a bare name", ( ) => {
    expect( fileExtension( "file:///var/photos/IMG_0001.HEIC" ) ).toBe( "heic" );
    expect( fileExtension( "IMG_0001.jpg" ) ).toBe( "jpg" );
  } );

  it( "ignores a query string", ( ) => {
    expect( fileExtension( "ph://ABC-123/L0/001.jpg?width=100" ) ).toBe( "jpg" );
  } );

  it( "reports unknown when there is no usable extension", ( ) => {
    expect( fileExtension( undefined ) ).toBe( "unknown" );
    expect( fileExtension( "" ) ).toBe( "unknown" );
    expect( fileExtension( "IMG_0001" ) ).toBe( "unknown" );
    expect( fileExtension( "trailing." ) ).toBe( "unknown" );
    expect( fileExtension( ".hidden" ) ).toBe( "unknown" );
  } );
} );

describe( "summarizeTypes", ( ) => {
  it( "counts types, most common first", ( ) => {
    expect( summarizeTypes( ["jpg", "heic", "jpg"] ) ).toBe( "jpg:2 heic:1" );
  } );

  it( "normalizes case and groups missing values", ( ) => {
    expect( summarizeTypes( ["JPG", "jpg", null, undefined, " "] ) )
      .toBe( "unknown:3 jpg:2" );
  } );

  it( "returns an empty string for no files", ( ) => {
    expect( summarizeTypes( [] ) ).toBe( "" );
  } );
} );

describe( "totalMegabytes", ( ) => {
  it( "sums sizes to one decimal place", ( ) => {
    expect( totalMegabytes( [1_500_000, 2_000_000] ) ).toBe( 3.5 );
  } );

  it( "skips sizes it does not have", ( ) => {
    expect( totalMegabytes( [null, undefined, -1, 1_000_000] ) ).toBe( 1 );
    expect( totalMegabytes( [] ) ).toBe( 0 );
  } );
} );
