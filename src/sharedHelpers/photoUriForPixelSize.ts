// iNaturalist serves each photo at fixed sizes (longest side, in pixels) that
// share a URL apart from the size segment, e.g. .../photos/123/original.jpg.
// Original is up to 2048px.
const SIZES: [string, number][] = [
  ["medium", 500],
  ["large", 1024],
];

const ORIGINAL_REGEX = /\/original\.(jpe?g|png|gif)/i;

// The smallest variant of a remote original-size iNaturalist photo URL whose
// shorter side still covers `pixels` device pixels, so a tile that fills a
// square with the photo stays sharp. Anything else (a local file, a non-
// iNaturalist URL, a size already chosen by the caller) is returned as is.
const photoUriForPixelSize = ( uri: string, pixels: number ): string => {
  if ( !/^https?:\/\//i.test( uri ) || !ORIGINAL_REGEX.test( uri ) ) return uri;
  // Photos are rarely more oblong than 4:3, so a variant's shorter side is
  // at least three quarters of its longest.
  const match = SIZES.find( ( [, longest] ) => longest * 0.75 >= pixels );
  return match
    ? uri.replace( ORIGINAL_REGEX, `/${match[0]}.$1` )
    : uri;
};

export default photoUriForPixelSize;
