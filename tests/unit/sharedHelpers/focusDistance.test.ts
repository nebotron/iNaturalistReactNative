import { readJpegFocusDistance } from "sharedHelpers/focusDistance";

/* eslint-disable no-bitwise -- building binary fixture bytes */
// A minimal little-endian Canon TIFF block: IFD0 -> Exif IFD -> MakerNote ->
// ShotInfo, with the focus distance range at indexes 19/20.
const canonTiff = ( upper: number, lower: number ): number[] => {
  const tiff: number[] = [];
  const u16 = ( v: number ) => tiff.push( v & 0xff, ( v >> 8 ) & 0xff );
  const u32 = ( v: number ) => { u16( v & 0xffff ); u16( v >>> 16 ); };
  const entry = ( tag: number, type: number, count: number, value: number ) => {
    u16( tag ); u16( type ); u32( count ); u32( value );
  };
  tiff.push( 0x49, 0x49 ); u16( 42 ); u32( 8 );
  u16( 1 ); entry( 0x8769, 4, 1, 26 ); u32( 0 ); // IFD0 at 8, ends at 26
  u16( 1 ); entry( 0x927c, 7, 30, 44 ); u32( 0 ); // Exif IFD at 26, ends at 44
  u16( 1 ); entry( 0x0004, 3, 34, 62 ); u32( 0 ); // MakerNote at 44, ends at 62
  for ( let i = 0; i < 34; i += 1 ) {
    let value = 0;
    if ( i === 19 ) value = upper;
    if ( i === 20 ) value = lower;
    u16( value );
  }
  return tiff;
};

const ascii = ( text: string ) => [...text].map( c => c.charCodeAt( 0 ) );

// SOI, then APP1 holding the TIFF block.
const canonJpeg = ( upper: number, lower: number ): string => {
  const app1 = ascii( "Exif\0\0" ).concat( canonTiff( upper, lower ) );
  const length = app1.length + 2;
  const bytes = [0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...app1, 0xff, 0xda];
  return String.fromCharCode( ...bytes );
};

// A minimal HEIF: ftyp, then a meta box whose iinf and iloc place an Exif item
// right after it.
const canonHeif = ( upper: number, lower: number ): string => {
  const be = ( v: number, size: number ) => Array.from(
    { length: size },
    ( _, i ) => ( v >>> ( 8 * ( size - 1 - i ) ) ) & 0xff,
  );
  const box = ( type: string, payload: number[] ) => [
    ...be( payload.length + 8, 4 ), ...ascii( type ), ...payload,
  ];
  const ftyp = box( "ftyp", ascii( "heix\0\0\0\0mif1heix" ) );
  const infe = box( "infe", [2, 0, 0, 0, ...be( 1, 2 ), 0, 0, ...ascii( "Exif" )] );
  const iinf = box( "iinf", [0, 0, 0, 0, ...be( 1, 2 ), ...infe] );
  const exif = [...be( 6, 4 ), ...ascii( "Exif\0\0" ), ...canonTiff( upper, lower )];
  const ilocSize = 8 + 4 + 2 + 2 + 2 + 2 + 2 + 4 + 4;
  const metaSize = 8 + 4 + iinf.length + ilocSize;
  const offset = ftyp.length + metaSize;
  const iloc = box( "iloc", [
    0, 0, 0, 0, 0x44, 0x00, ...be( 1, 2 ), ...be( 1, 2 ), 0, 0, ...be( 1, 2 ),
    ...be( offset, 4 ), ...be( exif.length, 4 ),
  ] );
  const meta = box( "meta", [0, 0, 0, 0, ...iinf, ...iloc] );
  return String.fromCharCode( ...ftyp, ...meta, ...exif );
};

const reader = ( data: string ) => async ( length: number, position: number ) => (
  data.slice( position, position + length )
);

describe( "readJpegFocusDistance", ( ) => {
  it( "returns the middle of Canon's focus distance range in metres", async ( ) => {
    const data = canonJpeg( 664, 742 );
    expect( await readJpegFocusDistance( reader( data ), data.length ) ).toBeCloseTo( 7.03 );
  } );

  it( "returns null for an infinite or unknown distance", async ( ) => {
    const infinite = canonJpeg( 0xffff, 5000 );
    expect( await readJpegFocusDistance( reader( infinite ), infinite.length ) ).toBeNull( );
    const unknown = canonJpeg( 0, 0 );
    expect( await readJpegFocusDistance( reader( unknown ), unknown.length ) ).toBeNull( );
  } );

  it( "reads the distance from a Canon HEIF's Exif item", async ( ) => {
    const data = canonHeif( 664, 742 );
    expect( await readJpegFocusDistance( reader( data ), data.length ) ).toBeCloseTo( 7.03 );
  } );
} );
