// react-native-exify resolves its argument with [NSURL URLWithString:], which
// returns nil for any URI string that isn't a valid, percent-encoded URL — a
// space, a "#", or a non-ASCII character in the filename is enough — and the
// module then rejects with "Invalid URI".
//
// That matters most in the photo importer: an imported photo keeps its device
// filename ("Screen Shot 2024-01-01 at 1.00.00 PM.png", names from AirDrop,
// WhatsApp, or a non-Latin keyboard), and its file:// uri is built by
// concatenation, so every EXIF read on one of those failed and the observation
// was created with no location at all. Photos the app writes itself get
// generated names, which is why the camera never hit this.
//
// Only file:// uris and bare paths are rewritten. Other schemes (ph://,
// content://, https://) either carry no path to encode or arrive encoded.

// Encode each segment separately so the path separators survive.
const encodePath = ( path: string ): string => path
  .split( "/" )
  .map( segment => encodeURIComponent( segment ) )
  .join( "/" );

const exifUri = ( pathOrUri: string ): string => {
  if ( pathOrUri.startsWith( "/" ) ) {
    return `file://${encodePath( pathOrUri )}`;
  }
  if ( pathOrUri.startsWith( "file://" ) ) {
    return `file://${encodePath( pathOrUri.slice( "file://".length ) )}`;
  }
  return pathOrUri;
};

export default exifUri;
