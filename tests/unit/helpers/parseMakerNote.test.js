// Bitwise ops are the natural way to assemble the big-endian test buffer.
/* eslint-disable no-bitwise */
import parseMakerNote from "sharedHelpers/exif/parseMakerNote";

// Build a minimal but valid big-endian ("MM") JPEG with an APP1/Exif segment
// containing IFD0 (Make + Exif pointer), an Exif IFD (with a MakerNote), and a
// Canon MakerNote IFD holding CanonShotInfo with focus-distance fields. Offsets
// in the IFDs are relative to the TIFF header start, matching real files.
const buildCanonJpeg = ( {
  make = "Canon",
  focusUpperRaw,
  focusLowerRaw,
} = {} ) => {
  // --- TIFF block (big-endian) ---
  // Layout inside the TIFF block (offsets from tiffStart):
  //   0  : "MM" 0x002A, IFD0 offset (8)
  //   8  : IFD0
  //   ...: Make string
  //   ...: Exif IFD
  //   ...: Canon MakerNote IFD
  //   ...: CanonShotInfo data
  const parts = [];
  const push = arr => parts.push( ...arr );
  const u16 = n => [( n >> 8 ) & 0xff, n & 0xff];
  const u32 = n => [
    ( n >> 24 ) & 0xff,
    ( n >> 16 ) & 0xff,
    ( n >> 8 ) & 0xff,
    n & 0xff,
  ];

  // CanonShotInfo: 22 int16 words. Index 19/20 hold focus distances, stored
  // byte-swapped relative to the file (little-endian here, since file is MM).
  const shotInfoWordCount = 22;
  const shotInfo = [];
  for ( let i = 0; i < shotInfoWordCount; i += 1 ) shotInfo.push( 0, 0 );
  const writeRevWord = ( wordIndex, raw ) => {
    // little-endian (reversed from the MM file order)
    shotInfo[wordIndex * 2] = raw & 0xff;
    shotInfo[wordIndex * 2 + 1] = ( raw >> 8 ) & 0xff;
  };
  if ( focusUpperRaw !== undefined ) writeRevWord( 19, focusUpperRaw );
  if ( focusLowerRaw !== undefined ) writeRevWord( 20, focusLowerRaw );

  // Reserve header
  push( [0x4d, 0x4d] ); // MM
  push( u16( 0x002a ) );
  push( u32( 8 ) ); // IFD0 at offset 8

  // We need to know offsets before writing pointers, so compute a layout.
  const makeBytes = [];
  for ( let i = 0; i < make.length; i += 1 ) makeBytes.push( make.charCodeAt( i ) );
  makeBytes.push( 0 );
  while ( makeBytes.length % 2 !== 0 ) makeBytes.push( 0 );

  // Offsets (from tiffStart):
  const ifd0Offset = 8;
  const ifd0Size = 2 + 2 * 12 + 4; // count + 2 entries + next-ifd
  const makeOffset = ifd0Offset + ifd0Size;
  const exifIfdOffset = makeOffset + makeBytes.length;
  const exifIfdSize = 2 + 1 * 12 + 4; // count + 1 entry (MakerNote) + next
  const makerNoteOffset = exifIfdOffset + exifIfdSize;
  const makerNoteSize = 2 + 1 * 12 + 4; // count + 1 entry (ShotInfo) + next
  const shotInfoOffset = makerNoteOffset + makerNoteSize;

  // --- IFD0: Make (0x010F ASCII) + ExifIFD pointer (0x8769 LONG) ---
  push( u16( 2 ) );
  // Make
  push( u16( 0x010f ) );
  push( u16( 2 ) ); // ASCII
  push( u32( makeBytes.length ) );
  push( u32( makeOffset ) );
  // Exif IFD pointer
  push( u16( 0x8769 ) );
  push( u16( 4 ) ); // LONG
  push( u32( 1 ) );
  push( u32( exifIfdOffset ) );
  push( u32( 0 ) ); // next IFD

  // Make string
  push( makeBytes );

  // --- Exif IFD: MakerNote (0x927C UNDEFINED) ---
  push( u16( 1 ) );
  push( u16( 0x927c ) );
  push( u16( 7 ) ); // UNDEFINED
  push( u32( makerNoteSize ) );
  push( u32( makerNoteOffset ) );
  push( u32( 0 ) ); // next IFD

  // --- Canon MakerNote IFD: CanonShotInfo (0x0004 SHORT[22]) ---
  push( u16( 1 ) );
  push( u16( 0x0004 ) );
  push( u16( 3 ) ); // SHORT
  push( u32( shotInfoWordCount ) );
  push( u32( shotInfoOffset ) );
  push( u32( 0 ) ); // next IFD

  // CanonShotInfo data
  push( shotInfo );

  const tiff = parts;

  // --- Wrap in a JPEG APP1/Exif segment ---
  const exifHeader = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const segPayloadLen = exifHeader.length + tiff.length;
  const segLen = segPayloadLen + 2; // length field includes itself
  const jpeg = [
    0xff, 0xd8, // SOI
    0xff, 0xe1, // APP1
    ( segLen >> 8 ) & 0xff, segLen & 0xff,
    ...exifHeader,
    ...tiff,
  ];
  return new Uint8Array( jpeg );
};

describe( "parseMakerNote", ( ) => {
  it( "decodes Canon focus distance from the MakerNote", ( ) => {
    // 255 cm upper, 240 cm lower -> 2.55 m / 2.40 m
    const bytes = buildCanonJpeg( { focusUpperRaw: 255, focusLowerRaw: 240 } );
    const result = parseMakerNote( bytes );

    expect( result ).not.toBeNull( );
    expect( result.FocusDistanceUpper ).toBe( "2.55 m" );
    expect( result.FocusDistanceLower ).toBe( "2.40 m" );
    expect( result.FocusDistance ).toBe( "2.40 m–2.55 m" );
    // The raw CanonShotInfo array is surfaced too
    expect( result.CanonShotInfo ).toBeDefined( );
  } );

  it( "reports a single distance when upper and lower match", ( ) => {
    const bytes = buildCanonJpeg( { focusUpperRaw: 300, focusLowerRaw: 300 } );
    const result = parseMakerNote( bytes );
    expect( result.FocusDistance ).toBe( "3.00 m" );
  } );

  it( "treats very large distances as infinity", ( ) => {
    const bytes = buildCanonJpeg( { focusUpperRaw: 0xffff, focusLowerRaw: 0xffff } );
    const result = parseMakerNote( bytes );
    expect( result.FocusDistance ).toBe( "inf" );
  } );

  it( "omits focus distance when the camera recorded none (zeros)", ( ) => {
    const bytes = buildCanonJpeg( { focusUpperRaw: 0, focusLowerRaw: 0 } );
    const result = parseMakerNote( bytes );
    expect( result.FocusDistance ).toBeUndefined( );
  } );

  it( "returns null for a non-Canon make", ( ) => {
    const bytes = buildCanonJpeg( { make: "NIKON", focusUpperRaw: 255 } );
    expect( parseMakerNote( bytes ) ).toBeNull( );
  } );

  it( "returns null for non-image bytes", ( ) => {
    expect( parseMakerNote( new Uint8Array( [1, 2, 3, 4] ) ) ).toBeNull( );
  } );
} );
