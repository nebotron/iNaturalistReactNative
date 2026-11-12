import { read, stat } from "@dr.pogodin/react-native-fs";
import * as Exify from "@lodev09/react-native-exify";
import { NativeModules, Platform } from "react-native";
import type { Box, SliceReader } from "sharedHelpers/cr3Metadata";
import {
  boxes,
  Bytes,
  canonFocusDistance,
  isCanonRawUri,
  parseTiff,
  readCr3SummaryFromFile,
} from "sharedHelpers/cr3Metadata";
import exifUri from "sharedHelpers/exifUri";
import { log } from "sharedHelpers/logger";
import stripFilePrefix from "sharedHelpers/stripFilePrefix";

const logger = log.extend( "focusDistance" );

// Why a read found no distance, for the log.
type OnMiss = ( reason: string ) => void;

// The Exif segment is at most 64KB and sits right after SOI (and maybe JFIF).
const JPEG_HEADER_BYTES = 128 * 1024;

// Focus distance in metres from the Canon MakerNote ShotInfo of the TIFF
// (Exif) block at `base`.
function tiffFocusDistance( bytes: Bytes, base: number, miss: ( reason: string ) => null ) {
  const exifPointer = parseTiff( bytes, base ).get( 0x8769 );
  if ( !exifPointer ) return miss( "no_exif_ifd" );
  if ( bytes.text( base, 2 ) !== "II" ) return miss( "big_endian" );
  const exif = parseTiff( bytes, base, bytes.u32le( exifPointer.valueOffset ) );
  const makerNote = exif.get( 0x927c );
  if ( !makerNote ) return miss( "no_makernote" );
  // Canon's MakerNote is a bare IFD whose offsets count from the TIFF header.
  const maker = parseTiff( bytes, base, makerNote.valueOffset - base );
  const shotInfo = maker.get( 0x0004 );
  if ( !shotInfo ) return miss( "no_shot_info" );
  return canonFocusDistance( bytes, shotInfo ) ?? miss( "shot_info_without_distance" );
}

const uint = ( bytes: Bytes, pos: number, size: number ): number => {
  if ( size === 2 ) return bytes.u16be( pos );
  if ( size === 4 ) return bytes.u32be( pos );
  if ( size === 8 ) return bytes.u64be( pos );
  return 0;
};

// Where a HEIF's Exif item lies in the file, from its meta box's iinf and iloc.
function heifExifLocation(
  bytes: Bytes,
  meta: Box,
): { offset: number; length: number } | null {
  // meta, iinf, infe and iloc are full boxes: version and flags come first.
  const children = boxes( bytes, meta.start + 4, meta.end );
  const iinf = children.find( box => box.type === "iinf" );
  const iloc = children.find( box => box.type === "iloc" );
  if ( !iinf || !iloc ) return null;
  const iinfHeader = iinf.start + 4 + ( bytes.u8( iinf.start ) === 0
    ? 2
    : 4 );
  let exifId: number | null = null;
  boxes( bytes, iinfHeader, iinf.end ).forEach( infe => {
    const version = bytes.u8( infe.start );
    if ( infe.type !== "infe" || version < 2 ) return;
    const idSize = version === 2
      ? 2
      : 4;
    const type = bytes.text( infe.start + 4 + idSize + 2, 4 );
    if ( type === "Exif" && exifId === null ) exifId = uint( bytes, infe.start + 4, idSize );
  } );
  if ( exifId === null ) return null;

  const version = bytes.u8( iloc.start );
  let pos = iloc.start + 4;
  /* eslint-disable no-bitwise -- packed field sizes */
  const offsetSize = bytes.u8( pos ) >> 4;
  const lengthSize = bytes.u8( pos ) & 0xf;
  const baseOffsetSize = bytes.u8( pos + 1 ) >> 4;
  const indexSize = version > 0
    ? bytes.u8( pos + 1 ) & 0xf
    : 0;
  /* eslint-enable no-bitwise */
  pos += 2;
  const idSize = version < 2
    ? 2
    : 4;
  const itemCount = uint( bytes, pos, idSize );
  pos += idSize;
  for ( let i = 0; i < itemCount && pos < iloc.end; i += 1 ) {
    const id = uint( bytes, pos, idSize );
    pos += idSize + ( version > 0
      ? 2
      : 0 ) + 2; // construction method, data reference index
    const baseOffset = uint( bytes, pos, baseOffsetSize );
    pos += baseOffsetSize;
    const extentCount = bytes.u16be( pos );
    pos += 2;
    const extentSize = indexSize + offsetSize + lengthSize;
    if ( id === exifId && extentCount > 0 ) {
      return {
        offset: baseOffset + uint( bytes, pos + indexSize, offsetSize ),
        length: uint( bytes, pos + indexSize + offsetSize, lengthSize ),
      };
    }
    pos += extentCount * extentSize;
  }
  return null;
}

// Focus distance in metres from a Canon JPEG's or HEIF's MakerNote ShotInfo.
export async function readJpegFocusDistance(
  readSlice: SliceReader,
  fileSize: number,
  onMiss: OnMiss = ( ) => undefined,
): Promise<number | null> {
  const miss = ( reason: string ) => {
    onMiss( reason );
    return null;
  };
  const bytes = new Bytes( await readSlice( Math.min( JPEG_HEADER_BYTES, fileSize ), 0 ) );
  if ( bytes.u16be( 0 ) !== 0xffd8 ) {
    // A HEIF (Canon's .HIF) keeps its Exif as an item located by the meta box.
    const top = boxes( bytes, 0, bytes.length );
    const meta = top[0]?.type === "ftyp" && top.find( box => box.type === "meta" );
    if ( !meta ) return miss( "not_jpeg_or_heif" );
    const location = heifExifLocation( bytes, meta );
    if ( !location ) return miss( "heif_without_exif" );
    const exif = new Bytes( await readSlice(
      Math.min( location.length, JPEG_HEADER_BYTES, fileSize - location.offset ),
      location.offset,
    ) );
    // The item starts with the offset of the TIFF header past these 4 bytes.
    return tiffFocusDistance( exif, 4 + exif.u32be( 0 ), miss );
  }
  let pos = 2;
  while ( pos + 4 <= bytes.length && bytes.u8( pos ) === 0xff ) {
    const marker = bytes.u8( pos + 1 );
    const length = bytes.u16be( pos + 2 );
    if ( marker === 0xda || length < 2 ) return miss( "no_exif_segment" );
    if ( marker === 0xe1 && bytes.text( pos + 4, 6 ) === "Exif" ) {
      return tiffFocusDistance( bytes, pos + 10, miss );
    }
    pos += 2 + length;
  }
  return miss( "no_exif_segment" );
}

export async function readFocusDistanceFromFile(
  pathOrUri: string,
  onMiss?: OnMiss,
): Promise<number | null> {
  if ( isCanonRawUri( pathOrUri ) ) {
    const distance = ( await readCr3SummaryFromFile( pathOrUri ) )?.focusDistance ?? null;
    if ( distance === null ) onMiss?.( "raw_without_distance" );
    return distance;
  }
  const path = stripFilePrefix( pathOrUri );
  const { size } = await stat( path );
  return readJpegFocusDistance(
    ( length, position ) => read( path, length, position, "ascii" ),
    Number( size ),
    onMiss,
  );
}

// The local copy of a photo is re-encoded through ImageIO, which keeps the
// standard Exif tags but drops Canon's MakerNote, so the focus distance only
// survives if it is copied into the standard SubjectDistance tag.
export async function copyFocusDistance( sourceUri: string, destinationUri: string ) {
  if ( sourceUri.startsWith( "ph://" ) ) return;
  try {
    const distance = await readFocusDistanceFromFile( sourceUri );
    if ( distance === null ) return;
    // iOS rewrites only the metadata; Exify decodes and re-encodes the photo,
    // which costs the upload copy another lossy JPEG generation.
    const writeSubjectDistance = ( NativeModules as {
      ImageCropper?: {
        writeSubjectDistance?: ( path: string, distance: number ) => Promise<boolean>;
      };
    } ).ImageCropper?.writeSubjectDistance;
    if ( Platform.OS === "ios" && writeSubjectDistance ) {
      await writeSubjectDistance( stripFilePrefix( destinationUri ), distance );
      return;
    }
    await Exify.write( exifUri( destinationUri ), { SubjectDistance: distance } );
  } catch ( error ) {
    logger.warn( "Could not copy the focus distance into a photo", error );
  }
}
