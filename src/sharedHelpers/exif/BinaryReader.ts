// Minimal endian-aware reader over a byte buffer, used to walk the TIFF/EXIF
// IFD structure and Canon MakerNote. Kept dependency-free so it can be unit
// tested against synthetic buffers.
export default class BinaryReader {
  bytes: Uint8Array;

  view: DataView;

  littleEndian: boolean;

  constructor( bytes: Uint8Array, littleEndian = false ) {
    this.bytes = bytes;
    this.view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    this.littleEndian = littleEndian;
  }

  get len( ): number {
    return this.bytes.length;
  }

  u8( offset: number ): number {
    return this.view.getUint8( offset );
  }

  u16( offset: number ): number {
    return this.view.getUint16( offset, this.littleEndian );
  }

  u32( offset: number ): number {
    return this.view.getUint32( offset, this.littleEndian );
  }

  // 16-bit unsigned read using the opposite byte order. Canon stores its
  // focus-distance fields byte-swapped relative to the rest of the file
  // (ExifTool's "int16uRev").
  u16Rev( offset: number ): number {
    return this.view.getUint16( offset, !this.littleEndian );
  }

  ascii( offset: number, length: number ): string {
    let out = "";
    for ( let i = 0; i < length; i += 1 ) {
      const code = this.bytes[offset + i];
      if ( code === 0 ) break;
      out += String.fromCharCode( code );
    }
    return out;
  }
}
