import { RealmContext } from "providers/contexts";
import { useCallback } from "react";
import InputImageRecord from "realmModels/InputImageRecord";
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
          .objects<InputImageRecord>( "InputImageRecord" )
          .filtered( "fileName = $0 AND wasDeleted = false", fileName );
        const now = new Date( );
        for ( const record of records ) {
          record.wasDeleted = true;
          record.deletedAt = now;
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
          .objects<InputImageRecord>( "InputImageRecord" )
          .filtered( "fileName = $0 AND wasDeleted = false", fileName );
        for ( const record of records ) {
          record.wasCropped = true;
          record.cropX = crop.x;
          record.cropY = crop.y;
          record.cropW = crop.w;
          record.cropH = crop.h;
        }
      } );
    } catch ( _e ) {
      // Don't let tracking errors affect the main image flow
    }
  }, [realm] );

  const getAllImageMetadata = useCallback( ( ) => (
    Array.from( realm.objects<InputImageRecord>( "InputImageRecord" ) ).map( r => ( {
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
    } ) )
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
