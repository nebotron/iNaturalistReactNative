// Native modules and file-system calls want a plain path, not a file:// uri.
const stripFilePrefix = ( uri: string ): string => uri.replace( /^file:\/\//, "" );

export default stripFilePrefix;
