import BinaryReader from "./BinaryReader";

// Decoded MakerNote fields, ready to merge into the metadata map shown to the
// user. Keys are chosen to read well in the metadata sheet.
export type MakerNoteData = Record<string, string | number | number[]>;

// TIFF field type -> size in bytes
const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

const TIFF_TAG_MAKE = 0x010f;
const TIFF_TAG_EXIF_IFD = 0x8769;
const EXIF_TAG_MAKER_NOTE = 0x927c;

// Canon MakerNote top-level tags we can name (see ExifTool Canon.pm). Unknown
// tags are still surfaced as "Canon 0xNNNN" so nothing is hidden.
const CANON_TAG_NAMES: Record<number, string> = {
  0x0001: "CanonCameraSettings",
  0x0002: "CanonFocalLength",
  0x0004: "CanonShotInfo",
  0x0006: "CanonImageType",
  0x0007: "CanonFirmwareVersion",
  0x0009: "OwnerName",
  0x000c: "SerialNumber",
  0x0026: "CanonAFInfo2",
  0x0093: "CanonFileInfo",
  0x0095: "LensModel",
  0x00a0: "CanonProcessingInfo",
};

const CANON_SHOT_INFO = 0x0004;
// Word (int16) indices within CanonShotInfo, per ExifTool. Index 0 is the
// byte-count, so the first real field is index 1.
const FOCUS_DISTANCE_UPPER_INDEX = 19;
const FOCUS_DISTANCE_LOWER_INDEX = 20;
// Canon focus distances are stored in cm; ExifTool treats anything above this
// (in metres) as infinity.
const FOCUS_DISTANCE_INFINITY_M = 655.345;

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  // Absolute offset into the buffer where this entry's value lives
  valueOffset: number;
  byteSize: number;
}

// Read the entries of a TIFF IFD located at absolute offset `ifdPos`. Value
// offsets stored in entries are relative to `tiffStart`.
const readIfd = (
  reader: BinaryReader,
  tiffStart: number,
  ifdPos: number,
): IfdEntry[] => {
  if ( ifdPos < 0 || ifdPos + 2 > reader.len ) return [];
  const count = reader.u16( ifdPos );
  // Guard against a bogus offset landing on huge/garbage data
  if ( count > 512 || ifdPos + 2 + count * 12 > reader.len ) return [];

  const entries: IfdEntry[] = [];
  for ( let i = 0; i < count; i += 1 ) {
    const entryPos = ifdPos + 2 + i * 12;
    const tag = reader.u16( entryPos );
    const type = reader.u16( entryPos + 2 );
    const num = reader.u32( entryPos + 4 );
    const byteSize = ( TYPE_SIZES[type] || 1 ) * num;
    const valueOffset = byteSize <= 4
      ? entryPos + 8
      : tiffStart + reader.u32( entryPos + 8 );
    entries.push( {
      tag, type, count: num, valueOffset, byteSize,
    } );
  }
  return entries;
};

const readValue = (
  reader: BinaryReader,
  entry: IfdEntry,
): string | number | number[] | null => {
  const {
    type, count, valueOffset, byteSize,
  } = entry;
  if ( valueOffset < 0 || valueOffset + byteSize > reader.len ) return null;

  if ( type === 2 ) {
    return reader.ascii( valueOffset, count ).replace( /\0+$/, "" );
  }

  const nums: number[] = [];
  for ( let i = 0; i < count; i += 1 ) {
    if ( type === 3 || type === 8 ) {
      nums.push( reader.u16( valueOffset + i * 2 ) );
    } else if ( type === 4 || type === 9 ) {
      nums.push( reader.u32( valueOffset + i * 4 ) );
    } else if ( type === 1 || type === 6 || type === 7 ) {
      nums.push( reader.u8( valueOffset + i ) );
    } else if ( type === 5 || type === 10 ) {
      const numerator = reader.u32( valueOffset + i * 8 );
      const denominator = reader.u32( valueOffset + i * 8 + 4 );
      nums.push(
        denominator
          ? numerator / denominator
          : 0,
      );
    } else {
      return null;
    }
  }
  return nums.length === 1
    ? nums[0]
    : nums;
};

// Locate the start of the TIFF/EXIF block. Handles JPEG (finds the APP1 "Exif"
// segment) and bare TIFF. Returns null for anything else (e.g. HEIF), where the
// EXIF is not laid out this way.
const locateTiffStart = ( bytes: Uint8Array ): number | null => {
  // JPEG: 0xFFD8 ... scan APP segments for APP1/Exif
  if ( bytes[0] === 0xff && bytes[1] === 0xd8 ) {
    let pos = 2;
    while ( pos + 4 <= bytes.length ) {
      if ( bytes[pos] !== 0xff ) return null;
      const marker = bytes[pos + 1];
      // Start of scan or end of image: no EXIF ahead
      if ( marker === 0xda || marker === 0xd9 ) return null;
      const segLen = bytes[pos + 2] * 256 + bytes[pos + 3];
      const isExifApp1 = marker === 0xe1
        && bytes[pos + 4] === 0x45 // E
        && bytes[pos + 5] === 0x78 // x
        && bytes[pos + 6] === 0x69 // i
        && bytes[pos + 7] === 0x66 // f
        && bytes[pos + 8] === 0x00
        && bytes[pos + 9] === 0x00;
      if ( isExifApp1 ) return pos + 10;
      if ( segLen < 2 ) return null;
      pos += 2 + segLen;
    }
    return null;
  }
  // Bare TIFF (II / MM)
  if (
    ( bytes[0] === 0x49 && bytes[1] === 0x49 )
    || ( bytes[0] === 0x4d && bytes[1] === 0x4d )
  ) {
    return 0;
  }
  return null;
};

const focusDistanceString = ( metres: number ): string => (
  metres > FOCUS_DISTANCE_INFINITY_M
    ? "inf"
    : `${metres.toFixed( 2 )} m`
);

// Extract the focus/subject distance Canon records per frame from CanonShotInfo.
const addCanonFocusDistance = (
  reader: BinaryReader,
  shotInfo: IfdEntry,
  out: MakerNoteData,
): void => {
  const upperPos = shotInfo.valueOffset + FOCUS_DISTANCE_UPPER_INDEX * 2;
  const lowerPos = shotInfo.valueOffset + FOCUS_DISTANCE_LOWER_INDEX * 2;
  if ( lowerPos + 2 > reader.len ) return;
  if ( shotInfo.count <= FOCUS_DISTANCE_LOWER_INDEX ) return;

  const upperM = reader.u16Rev( upperPos ) / 100;
  const lowerM = reader.u16Rev( lowerPos ) / 100;
  // Both zero means the camera did not record a distance for this frame
  if ( upperM === 0 && lowerM === 0 ) return;

  out.FocusDistanceUpper = focusDistanceString( upperM );
  out.FocusDistanceLower = focusDistanceString( lowerM );
  out.FocusDistance = upperM === lowerM
    ? focusDistanceString( upperM )
    : `${focusDistanceString( lowerM )}–${focusDistanceString( upperM )}`;
};

const parseCanonMakerNote = (
  reader: BinaryReader,
  tiffStart: number,
  makerNoteOffset: number,
): MakerNoteData => {
  const out: MakerNoteData = {};
  // Canon MakerNotes are a plain IFD with offsets relative to the TIFF start.
  const entries = readIfd( reader, tiffStart, makerNoteOffset );
  entries.forEach( entry => {
    if ( entry.tag === CANON_SHOT_INFO ) {
      addCanonFocusDistance( reader, entry, out );
    }
    const name = CANON_TAG_NAMES[entry.tag]
      || `Canon 0x${entry.tag.toString( 16 ).padStart( 4, "0" )}`;
    const value = readValue( reader, entry );
    if ( value !== null && value !== "" ) {
      out[name] = value;
    }
  } );
  return out;
};

// Parse the MakerNote out of a photo's raw EXIF bytes. Currently decodes Canon
// MakerNotes (camera/lens tags plus per-frame focus distance); returns null
// when there is no readable MakerNote.
const parseMakerNote = ( bytes: Uint8Array ): MakerNoteData | null => {
  try {
    const tiffStart = locateTiffStart( bytes );
    if ( tiffStart === null || tiffStart + 8 > bytes.length ) return null;

    const littleEndian = bytes[tiffStart] === 0x49;
    const reader = new BinaryReader( bytes, littleEndian );

    const ifd0Offset = tiffStart + reader.u32( tiffStart + 4 );
    const ifd0 = readIfd( reader, tiffStart, ifd0Offset );

    const makeEntry = ifd0.find( e => e.tag === TIFF_TAG_MAKE );
    const make = makeEntry
      ? String( readValue( reader, makeEntry ) || "" )
      : "";

    const exifPointer = ifd0.find( e => e.tag === TIFF_TAG_EXIF_IFD );
    if ( !exifPointer ) return null;
    const exifIfd = readIfd(
      reader,
      tiffStart,
      tiffStart + reader.u32( exifPointer.valueOffset ),
    );

    const makerNote = exifIfd.find( e => e.tag === EXIF_TAG_MAKER_NOTE );
    if ( !makerNote ) return null;

    if ( /canon/i.test( make ) ) {
      const data = parseCanonMakerNote(
        reader,
        tiffStart,
        makerNote.valueOffset,
      );
      return Object.keys( data ).length > 0
        ? data
        : null;
    }

    return null;
  } catch {
    // Malformed metadata: fail soft, the standard EXIF tags are still shown
    return null;
  }
};

export default parseMakerNote;
