import { read, stat } from "@dr.pogodin/react-native-fs";
import * as Exify from "@lodev09/react-native-exify";
import type { SliceReader } from "sharedHelpers/cr3Metadata";
import {
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

// The Exif segment is at most 64KB and sits right after SOI (and maybe JFIF).
const JPEG_HEADER_BYTES = 128 * 1024;

// Focus distance in metres from a Canon JPEG's MakerNote ShotInfo.
export async function readJpegFocusDistance(
  readSlice: SliceReader,
  fileSize: number,
): Promise<number | null> {
  const bytes = new Bytes( await readSlice( Math.min( JPEG_HEADER_BYTES, fileSize ), 0 ) );
  if ( bytes.u16be( 0 ) !== 0xffd8 ) return null;
  let pos = 2;
  while ( pos + 4 <= bytes.length && bytes.u8( pos ) === 0xff ) {
    const marker = bytes.u8( pos + 1 );
    const length = bytes.u16be( pos + 2 );
    if ( marker === 0xda || length < 2 ) return null;
    if ( marker === 0xe1 && bytes.text( pos + 4, 6 ) === "Exif" ) {
      const base = pos + 10;
      const exifPointer = parseTiff( bytes, base ).get( 0x8769 );
      if ( !exifPointer || bytes.text( base, 2 ) !== "II" ) return null;
      const exif = parseTiff( bytes, base, bytes.u32le( exifPointer.valueOffset ) );
      const makerNote = exif.get( 0x927c );
      if ( !makerNote ) return null;
      // Canon's MakerNote is a bare IFD whose offsets count from the TIFF header.
      const maker = parseTiff( bytes, base, makerNote.valueOffset - base );
      return canonFocusDistance( bytes, maker.get( 0x0004 ) );
    }
    pos += 2 + length;
  }
  return null;
}

export async function readFocusDistanceFromFile( pathOrUri: string ): Promise<number | null> {
  if ( isCanonRawUri( pathOrUri ) ) {
    return ( await readCr3SummaryFromFile( pathOrUri ) )?.focusDistance ?? null;
  }
  const path = stripFilePrefix( pathOrUri );
  const { size } = await stat( path );
  return readJpegFocusDistance(
    ( length, position ) => read( path, length, position, "ascii" ),
    Number( size ),
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
    await Exify.write( exifUri( destinationUri ), { SubjectDistance: distance } );
  } catch ( error ) {
    logger.warn( "Could not copy the focus distance into a photo", error );
  }
}
