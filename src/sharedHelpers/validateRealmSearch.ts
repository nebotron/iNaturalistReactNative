// realm doesn't allow non-alphanumeric characters in search queries
// so we need to first clean strings like "Ring-billed Gull"
// to prevent the app from crashing when this is called offline
//
// Whitespace and hyphens are stripped entirely (not just other punctuation)
// so search is agnostic to them: "ring-billed", "ring billed", and
// "ringbilled" all normalize to the same string and match
// Taxon._searchableName, which is normalized identically at write time
// (see Taxon.compileSearchableName).

const validateRealmSearch = ( searchString: string ) => {
  if ( !searchString ) {
    throw new Error( "Search string cannot be empty" );
  }

  const cleanedString = searchString.replace( /[^a-zA-Z0-9]/g, "" );

  if ( !cleanedString ) {
    throw new Error( "Search string contains only non-alphanumeric characters" );
  }

  return {
    cleanedQuery: cleanedString,
  };
};

export default validateRealmSearch;
