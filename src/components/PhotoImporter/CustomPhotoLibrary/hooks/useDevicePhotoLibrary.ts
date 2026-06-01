import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import {
  useCallback, useEffect, useRef, useState,
} from "react";

import { isCameraRollVideo, libraryPhotoFromCameraRoll } from "../helpers/cameraRollPhotoToAsset";
import type { LibraryPhoto } from "../types";

const PAGE_SIZE = 60;

interface Options {
  assetType: "mixed" | "photo";
  enabled: boolean;
}

const useDevicePhotoLibrary = ( { assetType, enabled }: Options ) => {
  const [photos, setPhotos] = useState<LibraryPhoto[]>( [] );
  const [isInitialLoading, setIsInitialLoading] = useState( true );
  const [isLoadingMore, setIsLoadingMore] = useState( false );
  const [hasNextPage, setHasNextPage] = useState( true );
  const [error, setError] = useState<string | null>( null );
  const endCursorRef = useRef<string | undefined>( undefined );
  const hasNextPageRef = useRef( true );
  const isFetchingRef = useRef( false );

  const loadPhotos = useCallback( async ( reset = false ) => {
    if ( !enabled || isFetchingRef.current ) {
      return;
    }

    if ( !reset && !hasNextPageRef.current ) {
      return;
    }

    isFetchingRef.current = true;
    if ( reset ) {
      setIsInitialLoading( true );
      endCursorRef.current = undefined;
      hasNextPageRef.current = true;
    } else {
      setIsLoadingMore( true );
    }

    try {
      const page = await CameraRoll.getPhotos( {
        first: PAGE_SIZE,
        after: reset
          ? undefined
          : endCursorRef.current,
        assetType: assetType === "photo"
          ? "Photos"
          : "All",
        include: ["filename", "fileSize", "playableDuration"],
      } );

      const nextPhotos = page.edges
        .filter( edge => (
          assetType === "photo"
            ? !isCameraRollVideo( edge )
            : true
        ) )
        .map( libraryPhotoFromCameraRoll );

      setPhotos( currentPhotos => (
        reset
          ? nextPhotos
          : [...currentPhotos, ...nextPhotos]
      ) );
      endCursorRef.current = page.page_info.end_cursor ?? undefined;
      hasNextPageRef.current = page.page_info.has_next_page;
      setHasNextPage( page.page_info.has_next_page );
      setError( null );
    } catch ( loadError ) {
      setError( loadError instanceof Error
        ? loadError.message
        : "Unable to load photos" );
    } finally {
      isFetchingRef.current = false;
      setIsInitialLoading( false );
      setIsLoadingMore( false );
    }
  }, [assetType, enabled] );

  useEffect( ( ) => {
    if ( !enabled ) {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPhotos( true );
  }, [enabled, assetType, loadPhotos] );

  const loadMorePhotos = useCallback( ( ) => {
    loadPhotos( false );
  }, [loadPhotos] );

  return {
    error,
    hasNextPage,
    isInitialLoading,
    isLoadingMore,
    loadMorePhotos,
    photos,
  };
};

export default useDevicePhotoLibrary;
