import { RealmContext } from "providers/contexts";
import { useCallback } from "react";
import * as uuid from "uuid";

const { useRealm } = RealmContext;

function getFileName( uri: string ): string {
  return uri.split( "/" ).pop( ) || uri;
}

interface CropData {
  x: number;
  y: number;
  width: number;
  height: number;
}

const useInputImageTracking = ( ) => {
  const realm = useRealm( );

  const trackImageLoaded = useCallback(
    (
      originalUri: string,
      source: "camera" | "photoLibrary",
      cropData?: CropData | null,
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
            wasCropped: cropData != null,
            cropX: cropData?.x ?? null,
            cropY: cropData?.y ?? null,
            cropWidth: cropData?.width ?? null,
            cropHeight: cropData?.height ?? null,
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
        cropWidth?: number;
        cropHeight?: number;
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
        cropWidth: r.cropWidth ?? null,
        cropHeight: r.cropHeight ?? null,
      };
    } )
  ), [realm] );

  return { trackImageLoaded, trackImageDeleted, getAllImageMetadata };
};

export default useInputImageTracking;
