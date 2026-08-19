// Compact descriptions of the files an import handled, for the app log.
//
// Extensions and MIME types only. A filename or a ph:// URI identifies the
// user's photo and belongs in a shared log no more than its coordinates do
// (see the export comments in PhotoLibrary), but the *kinds* of file in an
// import are what a later "why is this one missing?" question needs.

const UNKNOWN = "unknown";

export function fileExtension( pathOrName?: string | null ): string {
  if ( !pathOrName ) {
    return UNKNOWN;
  }
  const name = pathOrName.split( "?" )[0].split( "/" ).pop( ) ?? "";
  const dot = name.lastIndexOf( "." );
  if ( dot <= 0 || dot === name.length - 1 ) {
    return UNKNOWN;
  }
  return name.slice( dot + 1 ).toLowerCase( );
}

// [ "jpg", "jpg", "heic" ] => "jpg:2 heic:1", most common first, so one
// primitive log field carries the whole mix.
export function summarizeTypes( labels: readonly ( string | null | undefined )[] ): string {
  const counts = new Map<string, number>( );
  labels.forEach( label => {
    const key = label && label.trim( )
      ? label.trim( ).toLowerCase( )
      : UNKNOWN;
    counts.set( key, ( counts.get( key ) ?? 0 ) + 1 );
  } );
  return Array.from( counts.entries( ) )
    .sort( ( a, b ) => b[1] - a[1] || a[0].localeCompare( b[0] ) )
    .map( ( [type, count] ) => `${type}:${count}` )
    .join( " " );
}

export function totalMegabytes( sizes: readonly ( number | null | undefined )[] ): number {
  const bytes = sizes.reduce<number>(
    ( sum, size ) => sum + ( typeof size === "number" && size > 0
      ? size
      : 0 ),
    0,
  );
  return Math.round( bytes / 1e5 ) / 10;
}
