// Imported first thing in index.js: inatjs keeps its own reference to fetch
// when it's first imported, so the cached fetch has to be in place by then
import { installHttpCache } from "sharedHelpers/httpCache";

installHttpCache( );
