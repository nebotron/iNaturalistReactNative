import { exists, mkdir } from "@dr.pogodin/react-native-fs";
import { deviceThumbnailsPath } from "appConstants/paths";
import { useEffect, useState } from "react";
import { NativeModules } from "react-native";

interface ImageCropperModule {
  createThumbnail: (
    inputPath: string,
    maxPixel: number,
    outputPath: string,
  ) => Promise<string>;
}

const { ImageCropper } = NativeModules as { ImageCropper?: ImageCropperModule };

const cacheKey = ( uri: string, maxPixel: number ) => `${uri}:${maxPixel}`;

// djb2 → stable hex filename so a photo's thumbnail is reused across scroll
// recycling and app launches (uris can be long ph:// / file:// paths).
function hashKey( key: string ): string {
  let hash = 5381;
  for ( let i = 0; i < key.length; i += 1 ) {
    // eslint-disable-next-line no-bitwise
    hash = ( ( hash << 5 ) + hash ) ^ key.charCodeAt( i );
    // eslint-disable-next-line no-bitwise
    hash >>>= 0; // keep unsigned 32-bit
  }
  return hash.toString( 16 );
}

const memoryCache = new Map<string, string>( );
const inFlight = new Map<string, Promise<string | null>>( );

// Cap concurrent native thumbnail generations so a fast scroll through a large
// library doesn't fire hundreds of decodes at once.
const MAX_CONCURRENCY = 3;
let active = 0;
const queue: ( ( ) => void )[] = [];

const runNext = ( ) => {
  if ( active >= MAX_CONCURRENCY ) return;
  const job = queue.shift( );
  if ( !job ) return;
  active += 1;
  job( );
};

let dirReady: Promise<void> | null = null;
const ensureDir = ( ) => {
  if ( !dirReady ) dirReady = mkdir( deviceThumbnailsPath ).catch( ( ) => {} );
  return dirReady;
};

const generate = ( uri: string, maxPixel: number ): Promise<string | null> => (
  new Promise( resolve => {
    queue.push( ( ) => {
      ( async ( ) => {
        try {
          await ensureDir( );
          const outputPath = `${deviceThumbnailsPath}/${hashKey( cacheKey( uri, maxPixel ) )}.jpg`;
          if ( await exists( outputPath ) ) {
            resolve( `file://${outputPath}` );
            return;
          }
          const result = await ImageCropper!.createThumbnail( uri, maxPixel, outputPath );
          resolve( result || null );
        } catch {
          resolve( null );
        } finally {
          active -= 1;
          runNext( );
        }
      } )( );
    } );
    runNext( );
  } )
);

const getDeviceImageThumbnail = (
  uri: string,
  maxPixel: number,
): Promise<string | null> => {
  const key = cacheKey( uri, maxPixel );
  const cached = memoryCache.get( key );
  if ( cached ) return Promise.resolve( cached );
  const existing = inFlight.get( key );
  if ( existing ) return existing;
  const promise = generate( uri, maxPixel )
    .then( result => {
      if ( result ) memoryCache.set( key, result );
      return result;
    } )
    .finally( ( ) => inFlight.delete( key ) );
  inFlight.set( key, promise );
  return promise;
};

// Returns a small cached thumbnail uri for a device photo, generated off the
// UI thread so photo grids scroll without decoding full-resolution originals.
// Falls back to the original uri where the native generator isn't available
// (e.g. Android), and yields undefined until the thumbnail is ready so the
// caller can show a placeholder rather than the full-resolution image.
const useDeviceImageThumbnail = (
  uri: string | undefined,
  maxPixel: number,
): string | undefined => {
  const available = Boolean( ImageCropper?.createThumbnail );
  const [thumbUri, setThumbUri] = useState<string | undefined>( ( ) => {
    if ( !uri || !available ) return uri;
    return memoryCache.get( cacheKey( uri, maxPixel ) );
  } );

  useEffect( ( ) => {
    if ( !uri ) {
      setThumbUri( undefined );
      return ( ) => {};
    }
    if ( !available ) {
      setThumbUri( uri );
      return ( ) => {};
    }
    const cached = memoryCache.get( cacheKey( uri, maxPixel ) );
    if ( cached ) {
      setThumbUri( cached );
      return ( ) => {};
    }
    setThumbUri( undefined );
    let cancelled = false;
    getDeviceImageThumbnail( uri, maxPixel ).then( result => {
      // Fall back to the original uri if generation failed, so the cell shows
      // the photo (full-res) rather than staying blank forever.
      if ( !cancelled ) setThumbUri( result ?? uri );
    } );
    return ( ) => { cancelled = true; };
  }, [available, maxPixel, uri] );

  return thumbUri;
};

export default useDeviceImageThumbnail;
