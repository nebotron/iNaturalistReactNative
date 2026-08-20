import { isCanonRawUri, readCr3Summary } from "sharedHelpers/cr3Metadata";

/* eslint-disable no-bitwise -- building a binary file byte by byte */

// A CR3 built byte by byte, so the parser is exercised end to end without
// shipping a 30MB camera file in the repo. The layout mirrors what the real
// files hold: a Canon uuid box with the CMT TIFF blocks, and a CTMD track
// whose sample lives in mdat and carries the lens correction packet.
const ascii = text => [...text].map( character => character.charCodeAt( 0 ) );
const u32be = value => [
  ( value >>> 24 ) & 255, ( value >>> 16 ) & 255, ( value >>> 8 ) & 255, value & 255,
];
const u16le = value => [value & 255, ( value >>> 8 ) & 255];
const u32le = value => [
  value & 255, ( value >>> 8 ) & 255, ( value >>> 16 ) & 255, ( value >>> 24 ) & 255,
];
const i16le = value => u16le( value < 0
  ? value + 0x10000
  : value );
const box = ( type, payload ) => [...u32be( payload.length + 8 ), ...ascii( type ), ...payload];
const toBinaryString = bytes => bytes.map( byte => String.fromCharCode( byte ) ).join( "" );

// entries: [tag, type, count, payloadBytes]
function tiffBlock( entries ) {
  const header = [...ascii( "II*\0" ), ...u32le( 8 )];
  const ifd = [...u16le( entries.length )];
  const tail = [];
  const dataStart = 8 + 2 + ( 12 * entries.length ) + 4;
  entries.forEach( ( [tag, type, count, payload] ) => {
    ifd.push( ...u16le( tag ), ...u16le( type ), ...u32le( count ) );
    if ( payload.length <= 4 ) {
      ifd.push( ...payload, ...new Array( 4 - payload.length ).fill( 0 ) );
    } else {
      ifd.push( ...u32le( dataStart + tail.length ) );
      tail.push( ...payload );
    }
  } );
  ifd.push( ...u32le( 0 ) );
  return [...header, ...ifd, ...tail];
}

function lensPacket( ) {
  const values = new Array( 64 ).fill( 0 );
  values[0] = 0; // version, in the low byte
  values[1] = 1500;
  const points = 15;
  const falloff = Array.from(
    { length: points },
    ( _unused, i ) => 8191 - Math.round( 2000 * ( ( i / ( points - 1 ) ) ** 2 ) ),
  );
  const knots = Array.from(
    { length: points - 1 },
    ( _unused, i ) => Math.round( ( 4095 * ( i + 1 ) ) / ( points - 1 ) ),
  );
  const body = [
    ...values, ...falloff, ...new Array( 100 ).fill( 0 ), ...knots, ...new Array( 40 ).fill( 0 ),
  ];
  while ( body.length < 750 ) body.push( 0 );
  return body.flatMap( i16le );
}

function ctmdSample( ) {
  const packet = lensPacket( );
  const inner = tiffBlock( [[0x4015, 7, packet.length, packet]] );
  const exifInfo = [...u32le( inner.length + 8 ), ...u16le( 0x927c ), ...u16le( 0 ), ...inner];
  const record9 = [1, 1, 2, 1, 255, 255, ...exifInfo];
  return [...u32le( record9.length + 6 ), ...u16le( 9 ), ...record9];
}

function buildCr3( ) {
  const sample = ctmdSample( );
  const cmt1 = tiffBlock( [
    [0x010f, 2, 6, ascii( "Canon\0" )],
    [0x0110, 2, 14, ascii( "Canon EOS R7\0\0" )],
  ] );
  const cmt2 = tiffBlock( [
    [0x829d, 5, 1, [...u32le( 8 ), ...u32le( 1 )]],
    [0x8827, 3, 1, u16le( 100 )],
    [0x9003, 2, 4, ascii( "abc\0" )],
    [0x920a, 5, 1, [...u32le( 150 ), ...u32le( 1 )]],
    [0xa434, 2, 30, ascii( "RF-S18-150mm F3.5-6.3 IS STM\0\0" )],
  ] );
  const sensor = [18, 7128, 4732, 0, 0, 156, 84, 7115, 4723].flatMap( i16le );
  const aspect = [0, 6960, 4640, 0, 0].flatMap( u32le );
  const corrections = [44, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0].flatMap( u32le );
  const cmt3 = tiffBlock( [
    [0x0095, 2, 30, ascii( "RF-S18-150mm F3.5-6.3 IS STM\0\0" )],
    [0x009a, 7, aspect.length, aspect],
    [0x00e0, 7, sensor.length, sensor],
    [0x4016, 7, corrections.length, corrections],
  ] );

  const uuidPayload = [
    ...ascii( "\x85\xc0\xb6\x87\x82\x0f\x11\xe0\x81\x11\xf4\xceF+jH" ),
    ...box( "CMT1", cmt1 ),
    ...box( "CMT2", cmt2 ),
    ...box( "CMT3", cmt3 ),
    ...box( "CMT4", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] ),
  ];
  const stsd = box( "stsd", [...u32be( 0 ), ...u32be( 1 ), ...u32be( 16 ), ...ascii( "CTMD" )] );
  const stsz = box( "stsz", [...u32be( 0 ), ...u32be( sample.length ), ...u32be( 1 )] );
  const buildTrak = offset => box( "trak", box( "mdia", box( "minf", box( "stbl", [
    ...stsd,
    ...stsz,
    ...box( "co64", [...u32be( 0 ), ...u32be( 1 ), ...u32be( 0 ), ...u32be( offset )] ),
  ] ) ) ) );

  const ftyp = box( "ftyp", ascii( "crx isom" ) );
  // The sample's offset is only known once the boxes ahead of it are sized, and
  // co64 is fixed-width, so building it twice settles it.
  const provisional = box( "moov", [...box( "uuid", uuidPayload ), ...buildTrak( 0 )] );
  const offset = ftyp.length + provisional.length + 8;
  const moov = box( "moov", [...box( "uuid", uuidPayload ), ...buildTrak( offset )] );
  return [...ftyp, ...moov, ...box( "mdat", sample )];
}

const CR3 = toBinaryString( buildCr3( ) );
const readSlice = ( length, position ) => Promise.resolve(
  CR3.slice( position, position + length ),
);

describe( "isCanonRawUri", ( ) => {
  it( "recognises Canon raw files and nothing else", ( ) => {
    expect( isCanonRawUri( "file:///gallery/3S1A6473.CR3" ) ).toBe( true );
    expect( isCanonRawUri( "/gallery/img.cr2" ) ).toBe( true );
    expect( isCanonRawUri( "file:///photoUploads/IMG_1.jpg" ) ).toBe( false );
    expect( isCanonRawUri( "ph://ABC-123" ) ).toBe( false );
    expect( isCanonRawUri( undefined ) ).toBe( false );
  } );
} );

describe( "readCr3Summary", ( ) => {
  it( "reads the camera, lens and exposure", async ( ) => {
    const summary = await readCr3Summary( readSlice, CR3.length );

    expect( summary.make ).toBe( "Canon" );
    expect( summary.camera ).toBe( "Canon EOS R7" );
    expect( summary.lens ).toBe( "RF-S18-150mm F3.5-6.3 IS STM" );
    expect( summary.makerNoteLens ).toBe( "RF-S18-150mm F3.5-6.3 IS STM" );
    expect( summary.focalLength ).toBe( 150 );
    expect( summary.fNumber ).toBe( 8 );
    expect( summary.iso ).toBe( 100 );
    expect( summary.hasDateTimeOriginal ).toBe( true );
  } );

  it( "reads the sensor geometry and the corrections the camera was set to", async ( ) => {
    const summary = await readCr3Summary( readSlice, CR3.length );

    expect( summary.sensorWidth ).toBe( 7128 );
    expect( summary.activeWidth ).toBe( 6960 );
    expect( summary.activeHeight ).toBe( 4640 );
    expect( summary.cropWidth ).toBe( 6960 );
    expect( summary.peripheralLighting ).toBe( 1 );
    expect( summary.chromaticAberrationCorrection ).toBe( 1 );
    expect( summary.distortionCorrection ).toBe( 0 );
    expect( summary.digitalLensOptimizer ).toBe( 1 );
  } );

  it( "lists the tags present without reporting their values", async ( ) => {
    const summary = await readCr3Summary( readSlice, CR3.length );

    expect( summary.exifTags ).toEqual( [0x829d, 0x8827, 0x9003, 0x920a, 0xa434] );
    expect( summary.makerNoteTags ).toEqual( [0x0095, 0x009a, 0x00e0, 0x4016] );
  } );

  it( "finds the per-exposure lens correction packet in the CTMD track", async ( ) => {
    const summary = await readCr3Summary( readSlice, CR3.length );

    expect( summary.ctmdRecordTypes ).toContain( 9 );
    expect( summary.packetBytes ).toBe( 1500 );
    const falloff = summary.curves.find( curve => curve.kind === "falloff" );
    expect( falloff ).toBeDefined( );
    expect( falloff.points ).toBe( 15 );
    expect( falloff.first ).toBeCloseTo( 1, 3 );
    expect( falloff.last ).toBeLessThan( falloff.first );
    // Paired with the knot ramp that sits beside it in the packet.
    expect( falloff.knotCount ).toBe( 14 );
    expect( falloff.knotLast ).toBe( 4095 );
  } );

  it( "returns null for something that isn't a CR3", async ( ) => {
    const notACr3 = ( length, position ) => Promise.resolve(
      "not a raw file at all".slice( position, position + length ),
    );
    expect( await readCr3Summary( notACr3, 21 ) ).toBeNull( );
  } );
} );
