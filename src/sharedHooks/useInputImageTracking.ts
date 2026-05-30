import { RealmContext } from "providers/contexts";
import { useCallback } from "react";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import * as uuid from "uuid";

const { useRealm } = RealmContext;

function getFileName( uri: string ): string {
  return uri.split( "/" ).pop( ) || uri;
}

const useInputImageTracking = ( ) => {
  const realm = useRealm( );

  const trackImageLoaded = useCallback(
    (
      originalUri: string,
      source: "camera" | "photoLibrary",
    ) => {
      try {
        realm.write( ( ) => {
          realm.create( "InputImageRecord", {
            uuid: uuid.v4( ),
            originalUri,
            fileName: getFileName( originalUri ),
            source,
            loadedAt: new Date( ),
            wasDeleted: false,
            wasCropped: false,
            cropX: null,
            cropY: null,
            cropW: null,
            cropH: null,
          } );
        } );
      } catch ( _e ) {
        // Don't let tracking errors affect the main image flow
      }
    },
    [realm],
  );

  const trackImagesLoaded = useCallback(
    (
      originalUris: string[],
      source: "camera" | "photoLibrary",
    ) => {
      if ( originalUris.length === 0 ) return;
      try {
        const loadedAt = new Date( );
        realm.write( ( ) => {
          originalUris.forEach( originalUri => {
            realm.create( "InputImageRecord", {
              uuid: uuid.v4( ),
              originalUri,
              fileName: getFileName( originalUri ),
              source,
              loadedAt,
              wasDeleted: false,
              wasCropped: false,
              cropX: null,
              cropY: null,
              cropW: null,
              cropH: null,
            } );
          } );
        } );
      } catch ( _e ) {
        // Don't let tracking errors affect the main image flow
      }
    },
    [realm],
  );

  const trackImageDeleted = useCallback( ( uri: string ) => {
    try {
      const fileName = getFileName( uri );
      realm.write( ( ) => {
        const records = realm
          .objects( "InputImageRecord" )
          .filtered( "fileName = $0 AND wasDeleted = false", fileName );
        const now = new Date( );
        for ( const record of records ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ( record as any ).wasDeleted = true;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ( record as any ).deletedAt = now;
        }
      } );
    } catch ( _e ) {
      // Don't let tracking errors affect the main image flow
    }
  }, [realm] );

  const trackImageCropped = useCallback( ( uri: string, crop: NormalizedCrop ) => {
    try {
      const fileName = getFileName( uri );
      realm.write( ( ) => {
        const records = realm
          .objects( "InputImageRecord" )
          .filtered( "fileName = $0 AND wasDeleted = false", fileName );
        for ( const record of records ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = record as any;
          r.wasCropped = true;
          r.cropX = crop.x;
          r.cropY = crop.y;
          r.cropW = crop.w;
          r.cropH = crop.h;
        }
      } );
    } catch ( _e ) {
      // Don't let tracking errors affect the main image flow
    }
  }, [realm] );

  const getAllImageMetadata = useCallback( ( ) => (
    Array.from( realm.objects( "InputImageRecord" ) ).map( record => {
      const r = record as unknown as {
        uuid: string;
        originalUri: string;
        fileName: string;
        source: string;
        loadedAt: Date;
        wasDeleted: boolean;
        deletedAt?: Date;
        wasCropped: boolean;
        cropX?: number;
        cropY?: number;
        cropW?: number;
        cropH?: number;
      };
      return {
        uuid: r.uuid,
        originalUri: r.originalUri,
        fileName: r.fileName,
        source: r.source,
        loadedAt: r.loadedAt,
        wasDeleted: r.wasDeleted,
        deletedAt: r.deletedAt ?? null,
        wasCropped: r.wasCropped,
        cropX: r.cropX ?? null,
        cropY: r.cropY ?? null,
        cropW: r.cropW ?? null,
        cropH: r.cropH ?? null,
      };
    } )
  ), [realm] );

  return {
    trackImageLoaded,
    trackImagesLoaded,
    trackImageDeleted,
    trackImageCropped,
    getAllImageMetadata,
  };
};

export default useInputImageTracking;
