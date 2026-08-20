// Reads the metadata a Canon raw file carries, so an import can say what it was
// actually handed rather than what we assume it holds.
//
// CR3 is an ISO base media (BMFF) container. Everything here comes from two
// places:
//
//   moov/uuid(85c0b687-…)/CMT1..CMT3 — TIFF blocks holding IFD0, the Exif IFD
//     and the Canon MakerNote: camera, lens, exposure, sensor geometry, and
//     which corrections the camera was set to apply.
//   the CTMD track in mdat — per-exposure records. Record 9 wraps a small TIFF
//     whose MakerNote holds tag 0x4015, the correction data the camera read out
//     of the lens for that frame.
//
// Only the slices these need are read, not the 30MB file: the header, and the
// one CTMD sample at the offset the header points to.
//
// Field offsets for the Canon binary blocks follow ExifTool's Canon.pm. The
// layout of the curves inside 0x4015 is not documented, so they are found by
// shape (see scanCurves), the same way tools/craw does it.

import { read, stat } from "@dr.pogodin/react-native-fs";

// Reads `length` bytes at `position`, as one character per byte.
export type SliceReader = ( length: number, position: number ) => Promise<string>;

export interface Cr3Curve {
  kind: "falloff" | "gain";
  points: number;
  first: number;
  last: number;
  low: number;
  high: number;
  knotCount: number;
  knotLast: number;
}

export interface Cr3Summary {
  make?: string;
  camera?: string;
  lens?: string;
  makerNoteLens?: string;
  focalLength?: number;
  fNumber?: number;
  iso?: number;
  hasGps?: boolean;
  hasDateTimeOriginal?: boolean;
  sensorWidth?: number;
  sensorHeight?: number;
  activeWidth?: number;
  activeHeight?: number;
  cropWidth?: number;
  cropHeight?: number;
  cropLeft?: number;
  cropTop?: number;
  peripheralLighting?: number;
  chromaticAberrationCorrection?: number;
  distortionCorrection?: number;
  digitalLensOptimizer?: number;
  packetVersion?: number;
  packetBytes?: number;
  curves: Cr3Curve[];
  exifTags: number[];
  makerNoteTags: number[];
  ctmdRecordTypes: number[];
}

const CANON_UUID = "85c0b687820f11e08111f4ce462b6a48";

// The header is read in one go; 1MB covers moov on every sample seen (the
// largest was 90KB) with room for bodies that write more.
const HEADER_BYTES = 1024 * 1024;

/* eslint-disable no-bitwise -- reading bytes out of a binary file */
class Bytes {
  private readonly data: string;

  readonly length: number;

  constructor( data: string ) {
    this.data = data;
    this.length = data.length;
  }

  u8( offset: number ): number {
    return this.data.charCodeAt( offset ) & 0xff;
  }

  u16be( offset: number ): number {
    return ( this.u8( offset ) << 8 ) | this.u8( offset + 1 );
  }

  u32be( offset: number ): number {
    return ( this.u16be( offset ) * 0x10000 ) + this.u16be( offset + 2 );
  }

  u64be( offset: number ): number {
    return ( this.u32be( offset ) * 0x100000000 ) + this.u32be( offset + 4 );
  }

  u16le( offset: number ): number {
    return this.u8( offset ) | ( this.u8( offset + 1 ) << 8 );
  }

  i16le( offset: number ): number {
    const value = this.u16le( offset );
    return value > 0x7fff
      ? value - 0x10000
      : value;
  }

  u32le( offset: number ): number {
    return this.u16le( offset ) + ( this.u16le( offset + 2 ) * 0x10000 );
  }

  text( offset: number, length: number ): string {
    return this.data.slice( offset, offset + length ).split( "\0" )[0].trim( );
  }

  hex( offset: number, length: number ): string {
    /* eslint-enable no-bitwise */
    let out = "";
    for ( let i = 0; i < length; i += 1 ) {
      out += this.u8( offset + i ).toString( 16 ).padStart( 2, "0" );
    }
    return out;
  }
}

interface Box {
  type: string;
  start: number; // payload start
  end: number; // box end
}

function boxes( bytes: Bytes, start: number, end: number ): Box[] {
  const out: Box[] = [];
  let pos = start;
  while ( pos + 8 <= end ) {
    let size = bytes.u32be( pos );
    const type = bytes.text( pos + 4, 4 );
    let header = 8;
    if ( size === 1 ) {
      size = bytes.u64be( pos + 8 );
      header = 16;
    } else if ( size === 0 ) {
      size = end - pos;
    }
    if ( size < header || pos + size > end ) break;
    out.push( { type, start: pos + header, end: pos + size } );
    pos += size;
  }
  return out;
}

function findBox( bytes: Bytes, parent: Box, type: string ): Box | undefined {
  return boxes( bytes, parent.start, parent.end ).find( box => box.type === type );
}

function findPath( bytes: Bytes, parent: Box, path: string[] ): Box | undefined {
  return path.reduce<Box | undefined>(
    ( box, type ) => ( box
      ? findBox( bytes, box, type )
      : undefined ),
    parent,
  );
}

// ─── TIFF ────────────────────────────────────────────────────────────────────

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  valueOffset: number; // absolute offset of the entry's value field
}

const TYPE_SIZES: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

// Parses a TIFF block starting at `base` and returns its first IFD's entries.
function parseTiff( bytes: Bytes, base: number ): Map<number, IfdEntry> {
  const entries = new Map<number, IfdEntry>( );
  if ( base + 8 > bytes.length ) return entries;
  const little = bytes.text( base, 2 ) === "II";
  if ( !little && bytes.text( base, 2 ) !== "MM" ) return entries;
  const u16 = ( o: number ) => ( little
    ? bytes.u16le( o )
    : bytes.u16be( o ) );
  const u32 = ( o: number ) => ( little
    ? bytes.u32le( o )
    : bytes.u32be( o ) );
  const ifd = base + u32( base + 4 );
  if ( ifd + 2 > bytes.length ) return entries;
  const count = u16( ifd );
  for ( let i = 0; i < count; i += 1 ) {
    const entry = ifd + 2 + ( 12 * i );
    if ( entry + 12 > bytes.length ) break;
    const tag = u16( entry );
    const type = u16( entry + 2 );
    const values = u32( entry + 4 );
    const size = ( TYPE_SIZES[type] ?? 1 ) * values;
    const valueOffset = size <= 4
      ? entry + 8
      : base + u32( entry + 8 );
    entries.set( tag, {
      tag, type, count: values, valueOffset,
    } );
  }
  return entries;
}

const tiffString = ( bytes: Bytes, entry?: IfdEntry ): string | undefined => (
  entry && ( entry.type === 2 || entry.type === 7 )
    ? bytes.text( entry.valueOffset, entry.count ) || undefined
    : undefined
);

const tiffRational = ( bytes: Bytes, entry?: IfdEntry ): number | null => {
  if ( !entry || entry.type !== 5 ) return null;
  const denominator = bytes.u32le( entry.valueOffset + 4 );
  const numerator = bytes.u32le( entry.valueOffset );
  return denominator
    ? numerator / denominator
    : null;
};

const tiffShort = ( bytes: Bytes, entry?: IfdEntry ): number | undefined => (
  entry
    ? bytes.u16le( entry.valueOffset )
    : undefined
);

// Canon writes its binary blocks either as raw bytes or as a typed array; both
// index the same way, with element 0 holding the block's size.
function canonArray( bytes: Bytes, entry: IfdEntry | undefined, wide: boolean ): number[] {
  if ( !entry ) return [];
  const stride = wide
    ? 4
    : 2;
  const total = Math.floor( ( ( TYPE_SIZES[entry.type] ?? 1 ) * entry.count ) / stride );
  const out: number[] = [];
  for ( let i = 0; i < total; i += 1 ) {
    out.push( wide
      ? bytes.u32le( entry.valueOffset + ( i * 4 ) )
      : bytes.i16le( entry.valueOffset + ( i * 2 ) ) );
  }
  return out;
}

// ─── The lens correction packet (Canon tag 0x4015) ───────────────────────────

const GAIN_ONE = 16384;
const TRANSMISSION_ONE = 8191;

// Canon does not document this block and its field offsets move between
// bodies, so the curves are found by shape: a falloff curve starts at 8191 and
// decays, a gain curve starts at 16384 and stays near it, and a knot table is
// a rising radius ramp running out to the frame corner. Each curve takes the
// knot table nearest to it. The knot unit differs per body (the samples end at
// 4095, 4543 and 2934), so it is reported as-is rather than assumed.
function scanCurves( values: number[] ): Cr3Curve[] {
  const runs = ( test: ( value: number ) => boolean ): [number, number[]][] => {
    const found: [number, number[]][] = [];
    let i = 0;
    while ( i < values.length ) {
      if ( !test( values[i] ) ) {
        i += 1;
      } else {
        const start = i;
        while ( i < values.length && test( values[i] ) ) i += 1;
        found.push( [start, values.slice( start, i )] );
      }
    }
    return found;
  };

  const knots = runs( value => value > 0 && value < 8000 ).filter( ( [, run] ) => (
    run.length >= 8
    && run.every( ( value, i ) => i === 0 || value > run[i - 1] )
    && run[0] * 3 < run[run.length - 1]
  ) );

  const curves: { index: number; kind: "falloff" | "gain"; run: number[] }[] = [];
  runs( value => value >= 1500 && value <= TRANSMISSION_ONE ).forEach( ( [index, run] ) => {
    if (
      run.length >= 6
      && run[0] >= 8000
      && run.every( ( value, i ) => i === 0 || value <= run[i - 1] )
    ) {
      curves.push( { index, kind: "falloff", run } );
    }
  } );
  runs( value => value >= 12000 && value <= 21000 ).forEach( ( [index, run] ) => {
    if ( run.length >= 6 && run[0] === GAIN_ONE ) {
      curves.push( { index, kind: "gain", run } );
    }
  } );

  return curves.map( ( { index, kind, run } ) => {
    const one = kind === "falloff"
      ? TRANSMISSION_ONE
      : GAIN_ONE;
    const scaled = run.map( value => value / one );
    const nearest = knots
      .filter( ( [, k] ) => k.length === run.length || k.length === run.length - 1 )
      .sort( ( a, b ) => Math.abs( a[0] - index ) - Math.abs( b[0] - index ) )[0];
    return {
      kind,
      points: run.length,
      first: scaled[0],
      last: scaled[scaled.length - 1],
      low: Math.min( ...scaled ),
      high: Math.max( ...scaled ),
      knotCount: nearest
        ? nearest[1].length
        : 0,
      knotLast: nearest
        ? nearest[1][nearest[1].length - 1]
        : 0,
    };
  } );
}

// ─── CTMD (the per-exposure records, which live in mdat) ─────────────────────

interface Sample { offset: number; size: number }

function ctmdSample( bytes: Bytes, moov: Box ): Sample | null {
  const traks = boxes( bytes, moov.start, moov.end ).filter( box => box.type === "trak" );
  for ( const trak of traks ) {
    const stbl = findPath( bytes, trak, ["mdia", "minf", "stbl"] );
    const stsd = stbl && findBox( bytes, stbl, "stsd" );
    if ( !stbl || !stsd || bytes.text( stsd.start + 12, 4 ) !== "CTMD" ) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const stsz = findBox( bytes, stbl, "stsz" );
    const co64 = findBox( bytes, stbl, "co64" );
    const stco = findBox( bytes, stbl, "stco" );
    if ( !stsz || ( !co64 && !stco ) ) return null;
    const uniformSize = bytes.u32be( stsz.start + 4 );
    const size = uniformSize || bytes.u32be( stsz.start + 12 );
    const offset = co64
      ? bytes.u64be( co64.start + 8 )
      : bytes.u32be( stco!.start + 8 );
    if ( !size || !offset ) return null;
    return { offset, size };
  }
  return null;
}

// Records are {uint32 size, uint16 type, payload}. Types 7-9 wrap a small TIFF
// block behind a fixed header, and record 9 is the one holding tag 0x4015.
function ctmdRecords( bytes: Bytes ): Map<number, number> {
  const records = new Map<number, number>( );
  let pos = 0;
  while ( pos + 6 <= bytes.length ) {
    const size = bytes.u32le( pos );
    const type = bytes.u16le( pos + 4 );
    if ( size < 6 || pos + size > bytes.length ) break;
    if ( !records.has( type ) ) records.set( type, pos + 6 );
    pos += size;
  }
  return records;
}

function lensPacketFrom( bytes: Bytes, payloadStart: number ): {
  version: number; size: number; curves: Cr3Curve[];
} | null {
  // 6 bytes of record header, then {uint32 size, uint16 tag, uint16 pad} and a
  // self-contained TIFF block.
  const tiffStart = payloadStart + 14;
  if ( bytes.u16le( payloadStart + 10 ) !== 0x927c ) return null;
  const entries = parseTiff( bytes, tiffStart );
  const packet = entries.get( 0x4015 );
  if ( !packet || packet.count < 64 ) return null;
  const values: number[] = [];
  for ( let i = 0; i + 1 < packet.count; i += 2 ) {
    values.push( bytes.i16le( packet.valueOffset + i ) );
  }
  return {
    version: bytes.u8( packet.valueOffset ),
    size: packet.count,
    curves: scanCurves( values ),
  };
}

// ─── Assembly ────────────────────────────────────────────────────────────────

export async function readCr3Summary(
  readSlice: SliceReader,
  fileSize: number,
): Promise<Cr3Summary | null> {
  const header = new Bytes( await readSlice( Math.min( HEADER_BYTES, fileSize ), 0 ) );
  const top = boxes( header, 0, header.length );
  if ( !top.some( box => box.type === "ftyp" ) ) return null;
  const moov = top.find( box => box.type === "moov" );
  if ( !moov ) return null;

  const summary: Cr3Summary = {
    curves: [], exifTags: [], makerNoteTags: [], ctmdRecordTypes: [],
  };

  const uuid = boxes( header, moov.start, moov.end ).find( box => (
    box.type === "uuid" && header.hex( box.start, 16 ) === CANON_UUID
  ) );
  if ( uuid ) {
    boxes( header, uuid.start + 16, uuid.end ).forEach( box => {
      if ( box.type === "CMT1" ) {
        const ifd0 = parseTiff( header, box.start );
        summary.make = tiffString( header, ifd0.get( 0x010f ) );
        summary.camera = tiffString( header, ifd0.get( 0x0110 ) );
      }
      if ( box.type === "CMT2" ) {
        const exif = parseTiff( header, box.start );
        summary.exifTags = [...exif.keys( )].sort( ( a, b ) => a - b );
        summary.focalLength = tiffRational( header, exif.get( 0x920a ) ) ?? undefined;
        summary.fNumber = tiffRational( header, exif.get( 0x829d ) ) ?? undefined;
        summary.iso = tiffShort( header, exif.get( 0x8827 ) );
        summary.lens = tiffString( header, exif.get( 0xa434 ) );
        summary.hasDateTimeOriginal = exif.has( 0x9003 );
      }
      if ( box.type === "CMT3" ) {
        const maker = parseTiff( header, box.start );
        summary.makerNoteTags = [...maker.keys( )].sort( ( a, b ) => a - b );
        summary.makerNoteLens = tiffString( header, maker.get( 0x0095 ) );
        const sensor = canonArray( header, maker.get( 0x00e0 ), false );
        if ( sensor.length > 8 ) {
          [, summary.sensorWidth, summary.sensorHeight] = sensor;
          summary.activeWidth = sensor[7] - sensor[5] + 1;
          summary.activeHeight = sensor[8] - sensor[6] + 1;
        }
        const aspect = canonArray( header, maker.get( 0x009a ), true );
        if ( aspect.length > 4 ) {
          [, summary.cropWidth, summary.cropHeight, summary.cropLeft, summary.cropTop] = aspect;
        }
        const corrections = canonArray( header, maker.get( 0x4016 ), true );
        if ( corrections.length > 9 ) {
          summary.peripheralLighting = corrections[5];
          summary.chromaticAberrationCorrection = corrections[6];
          summary.distortionCorrection = corrections[7];
          summary.digitalLensOptimizer = corrections[9];
        }
      }
      if ( box.type === "CMT4" ) summary.hasGps = box.end > box.start + 8;
    } );
  }

  const sample = ctmdSample( header, moov );
  if ( sample ) {
    const ctmd = new Bytes( await readSlice( sample.size, sample.offset ) );
    const records = ctmdRecords( ctmd );
    summary.ctmdRecordTypes = [...records.keys( )].sort( ( a, b ) => a - b );
    const record9 = records.get( 9 );
    const packet = record9 === undefined
      ? null
      : lensPacketFrom( ctmd, record9 );
    if ( packet ) {
      summary.packetVersion = packet.version;
      summary.packetBytes = packet.size;
      summary.curves = packet.curves;
    }
  }

  return summary;
}

const RAW_EXTENSIONS = ["cr3", "cr2", "crw"];

export function isCanonRawUri( pathOrUri?: string | null ): boolean {
  if ( !pathOrUri ) return false;
  const name = pathOrUri.split( "?" )[0].split( "/" ).pop( ) ?? "";
  const dot = name.lastIndexOf( "." );
  return dot > 0 && RAW_EXTENSIONS.includes( name.slice( dot + 1 ).toLowerCase( ) );
}

export async function readCr3SummaryFromFile( pathOrUri: string ): Promise<Cr3Summary | null> {
  const path = pathOrUri.replace( /^file:\/\//, "" );
  const { size } = await stat( path );
  return readCr3Summary(
    ( length, position ) => read( path, length, position, "ascii" ),
    Number( size ),
  );
}
