import {
  copyFile,
  downloadFile,
  TemporaryDirectoryPath,
  unlink,
} from "@dr.pogodin/react-native-fs";
import type { ExifTags } from "@lodev09/react-native-exify";
import * as Exify from "@lodev09/react-native-exify";
import { WarningSheet } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Share, StatusBar } from "react-native";
import type { ICarouselInstance } from "react-native-reanimated-carousel";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Photo from "realmModels/Photo";
import { BREAKPOINTS } from "sharedHelpers/breakpoint";
import useDeviceOrientation from "sharedHooks/useDeviceOrientation";
import useTranslation from "sharedHooks/useTranslation";

import MainMediaDisplay from "./MainMediaDisplay";
import MediaSelector from "./MediaSelector";
import MediaViewerHeader from "./MediaViewerHeader";
import MetadataSheet from "./MetadataSheet";

interface MediaToDelete {
  type: "sound" | "photo";
  uri: string;
}

interface PhotoItem {
  attribution?: string;
  licenseCode?: string;
  localFilePath?: string;
  url?: string;
}

interface SoundItem {
  file_url: string;
  hidden: boolean;
}

interface Props {
  autoPlaySound?: boolean; // automatically start playing a sound when it is visible
  autoDetectSubject?: boolean;
  editable?: boolean;
  deleting?: boolean;
  // Optional component to use as the header
  header?: (
    { onClose, photoCount }: { onClose: ( ) => void; photoCount: number}
  ) => React.JSX.Element;
  initialIndex?: number;
  latitude?: number | null;
  longitude?: number | null;
  onClose?: ( ) => void;
  onCropPhoto?: Function;
  onDeletePhoto?: ( uri: string ) => void;
  onDeleteSound?: ( uri: string ) => void;
  onReorderPhotos?: Function;
  photos?: PhotoItem[];
  sounds?: SoundItem[];
  timeObservedAt?: string | null;
  uri?: string | null;
}

const MediaViewer = ( {
  autoPlaySound,
  autoDetectSubject,
  editable,
  deleting,
  header,
  initialIndex,
  latitude,
  longitude,
  onClose = ( ) => undefined,
  onCropPhoto,
  onDeletePhoto,
  onDeleteSound,
  onReorderPhotos,
  photos = [],
  sounds = [],
  timeObservedAt,
  uri,
}: Props ) => {
  const insets = useSafeAreaInsets();
  const uris = useMemo( ( ) => ( [
    ...photos.map( photo => photo.url || Photo.getLocalPhotoUri( photo.localFilePath ) ),
    ...sounds.map( sound => sound.file_url ),
  ] ), [photos, sounds] );

  const [selectedMediaIndex, setSelectedMediaIndex] = useState( ( ) => {
    if ( initialIndex != null && initialIndex >= 0 ) {
      return initialIndex;
    }
    const uriIndex = uris.indexOf( uri );
    return uriIndex <= 0
      ? 0
      : uriIndex;
  } );
  const { t } = useTranslation( );
  const [mediaToDelete, setMediaToDelete] = useState<MediaToDelete | null>( null );
  const [metadataPhoto, setMetadataPhoto] = useState<PhotoItem | null>( null );

  const horizontalScroll = useRef<ICarouselInstance>( null );

  const { screenWidth } = useDeviceOrientation( );
  const isLargeScreen = screenWidth > BREAKPOINTS.md;

  const scrollToIndex = useCallback( ( index: number ) => {
    // when a user taps an item in the carousel, the UI needs to automatically
    // scroll to the index of the item they selected
    setSelectedMediaIndex( index );
    horizontalScroll?.current?.scrollTo( { index, animated: true } );
  }, [setSelectedMediaIndex] );

  const handleReorderPhotos = useCallback( ( { data: newPhotoUris } ) => {
    if ( !onReorderPhotos ) {
      return;
    }

    const currentlySelectedUri = uris[selectedMediaIndex];
    onReorderPhotos( { data: newPhotoUris } );

    const newUris = [
      ...newPhotoUris,
      ...sounds.map( sound => sound.file_url ),
    ];
    const newIndex = newUris.indexOf( currentlySelectedUri );
    if ( newIndex >= 0 ) {
      setSelectedMediaIndex( newIndex );
      horizontalScroll?.current?.scrollTo( {
        index: newIndex,
        animated: true,
      } );
    }
  }, [
    onReorderPhotos,
    selectedMediaIndex,
    sounds,
    uris,
  ] );

  // If we've removed an item the selectedPhoto index might refer to a item
  // that no longer exists, so change it to the previous one
  useEffect( ( ) => {
    if ( selectedMediaIndex >= uris.length ) {
      const newIndex = Math.max( 0, selectedMediaIndex - 1 );
      setSelectedMediaIndex( newIndex );
      if ( uris.length > 0 ) {
        horizontalScroll?.current?.scrollTo( {
          index: newIndex,
          animated: false,
        } );
      }
    }
  }, [selectedMediaIndex, setSelectedMediaIndex, uris.length] );

  const confirmDelete = useCallback( ( ) => {
    if ( mediaToDelete?.type === "photo" && onDeletePhoto ) {
      onDeletePhoto( mediaToDelete.uri );
    } else if ( mediaToDelete?.type === "sound" && onDeleteSound ) {
      onDeleteSound( mediaToDelete.uri );
    }
    setMediaToDelete( null );
  }, [
    onDeletePhoto,
    onDeleteSound,
    mediaToDelete?.type,
    mediaToDelete?.uri,
    setMediaToDelete,
  ] );

  // Build a local, metadata-embedded copy of a photo we can hand to the share
  // sheet. This is the slow part (copy/download + EXIF write), so it runs ahead
  // of time (see the pre-warm effect below) rather than blocking the long press.
  const buildSharePhoto = useCallback( async ( photoUri: string ): Promise<string> => {
    // Unique per prep so an in-flight prep for a previous photo can't clobber
    // the file mid-write, which would produce a broken image iOS can't save.
    const tempPath = `${TemporaryDirectoryPath}/share_photo_${Date.now()}`
      + `_${Math.random().toString( 36 ).slice( 2 )}.jpg`;

    // Get a local file we can annotate and share
    if ( photoUri.startsWith( "file://" ) ) {
      await copyFile( photoUri.replace( "file://", "" ), tempPath );
    } else {
      await downloadFile( { fromUrl: photoUri, toFile: tempPath } ).promise;
    }

    // Embed location and time metadata
    const exifToWrite: ExifTags = {};
    if ( latitude != null && longitude != null ) {
      exifToWrite.GPSLatitude = latitude;
      exifToWrite.GPSLongitude = longitude;
    }
    if ( timeObservedAt ) {
      const d = new Date( timeObservedAt );
      const pad = ( n: number ) => String( n ).padStart( 2, "0" );
      const datePart = `${d.getFullYear()}:${pad( d.getMonth() + 1 )}:${pad( d.getDate() )}`;
      const timePart = `${pad( d.getHours() )}:${pad( d.getMinutes() )}:${pad( d.getSeconds() )}`;
      exifToWrite.DateTimeOriginal = `${datePart} ${timePart}`;
    }
    if ( Object.keys( exifToWrite ).length > 0 ) {
      try {
        await Exify.write( `file://${tempPath}`, exifToWrite );
      } catch ( _e ) {
        // Continue sharing even if EXIF write fails
      }
    }

    return tempPath;
  }, [latitude, longitude, timeObservedAt] );

  // Cache of the in-flight/prepared share file for a single photo uri so the
  // long press can present the sheet without waiting on file work.
  const sharePrepRef = useRef<{ uri: string; promise: Promise<string> } | null>( null );

  const prepareSharePhoto = useCallback( ( photoUri: string ): Promise<string> => {
    if ( sharePrepRef.current?.uri === photoUri ) {
      return sharePrepRef.current.promise;
    }
    const previous = sharePrepRef.current;
    const promise = buildSharePhoto( photoUri );
    sharePrepRef.current = { uri: photoUri, promise };
    // Clean up the previously prepared temp file once it has finished writing.
    if ( previous ) {
      previous.promise
        .then( path => unlink( path ).catch( ( ) => undefined ) )
        .catch( ( ) => undefined );
    }
    return promise;
  }, [buildSharePhoto] );

  // Pre-warm the shareable copy of the currently displayed photo so a long
  // press can present the share sheet the moment the threshold is hit, instead
  // of after the copy/EXIF work finishes (which lands around finger release).
  // Key off the same uri MainMediaDisplay passes to onLongPressPhoto so the
  // long press hits the cache rather than rebuilding.
  const currentPhoto = selectedMediaIndex < photos.length
    ? photos[selectedMediaIndex]
    : null;
  const currentShareUri = currentPhoto
    ? Photo.displayLocalOrRemoteLargePhoto( currentPhoto )
    : null;
  useEffect( ( ) => {
    if ( !currentShareUri ) return;
    prepareSharePhoto( currentShareUri ).catch( ( ) => undefined );
  }, [currentShareUri, prepareSharePhoto] );

  const handleLongPressPhoto = useCallback( async ( photoUri: string ) => {
    try {
      const tempPath = await prepareSharePhoto( photoUri );
      Share.share( { url: `file://${tempPath}` } );
    } catch ( _e ) {
      // Nothing to share if the file could not be prepared
    }
  }, [prepareSharePhoto] );

  return (
    <View
      className="flex-1 bg-white"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      testID="MediaViewer"
    >
      <StatusBar barStyle="light-content" />
      {
        header
          ? header( { onClose, photoCount: uris.length } )
          : (
            <MediaViewerHeader
              onClose={onClose}
              photoCount={photos.length}
              soundCount={sounds.length}
            />
          )
      }
      <MainMediaDisplay
        autoPlaySound={autoPlaySound}
        autoDetectSubject={autoDetectSubject}
        editable={editable}
        photos={photos}
        sounds={sounds}
        onClose={onClose}
        selectedMediaIndex={selectedMediaIndex}
        horizontalScroll={horizontalScroll}
        setSelectedMediaIndex={setSelectedMediaIndex}
        onCropPhoto={onCropPhoto}
        onDeletePhoto={photoUri => setMediaToDelete( { type: "photo", uri: photoUri } )}
        onDeleteSound={soundUri => setMediaToDelete( { type: "sound", uri: soundUri } )}
        onLongPressPhoto={handleLongPressPhoto}
        onShowMetadata={setMetadataPhoto}
      />
      <MediaSelector
        editable={editable}
        photos={photos}
        sounds={sounds}
        scrollToIndex={scrollToIndex}
        onReorderPhotos={handleReorderPhotos}
        isLargeScreen={isLargeScreen}
        selectedMediaIndex={selectedMediaIndex}
      />
      {( mediaToDelete || deleting ) && (
        <WarningSheet
          onPressClose={( ) => setMediaToDelete( null )}
          loading={deleting}
          confirm={confirmDelete}
          headerText={t( "DISCARD-MEDIA--question" )}
          buttonText={t( "DISCARD" )}
          secondButtonText={t( "CANCEL" )}
          handleSecondButtonPress={( ) => setMediaToDelete( null )}
          insideModal
          testID="MediaViewer.DiscardMediaWarningSheet"
        />
      )}
      {metadataPhoto && (
        <MetadataSheet
          photo={metadataPhoto}
          onClose={( ) => setMetadataPhoto( null )}
          insideModal
        />
      )}
    </View>
  );
};

export default MediaViewer;
