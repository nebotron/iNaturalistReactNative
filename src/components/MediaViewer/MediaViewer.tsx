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
import { format } from "date-fns";
import { RealmContext } from "providers/contexts";
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
import cropImageFile from "sharedHelpers/cropImageFile";
import { copyLibraryOriginal, findObservationPhoto } from "sharedHelpers/findLibraryOriginal";
import imageFileSize from "sharedHelpers/imageFileSize";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import stripFilePrefix from "sharedHelpers/stripFilePrefix";
import useDeviceOrientation from "sharedHooks/useDeviceOrientation";
import useTranslation from "sharedHooks/useTranslation";

import MainMediaDisplay from "./MainMediaDisplay";
import MediaSelector from "./MediaSelector";
import MediaViewerHeader from "./MediaViewerHeader";
import PhotoCameraInfo from "./PhotoCameraInfo";

const { useRealm } = RealmContext;

// A visible region at least this fraction of the photo on both sides is the
// whole photo; share the original untouched rather than re-encode it.
const FULL_FRAME = 0.995;

// A crop of a region that is itself a crop of the photo, in the photo's
// coordinates.
const cropWithin = ( outer: NormalizedCrop, inner?: NormalizedCrop ): NormalizedCrop => (
  inner
    ? {
      x: outer.x + inner.x * outer.w,
      y: outer.y + inner.y * outer.h,
      w: inner.w * outer.w,
      h: inner.h * outer.h,
    }
    : outer
);

// A prepared share file, and the crop that makes it the photo as uploaded:
// the library original is uncropped, so it carries the photo's saved crop.
interface SharePhotoFile {
  path: string;
  uploadCrop?: NormalizedCrop;
}

// Cut the prepared share file down to the part of the photo visible on
// screen, at full resolution. Null when the whole photo is visible or the
// crop can't be made (e.g. Android, which has no native cropper), in which
// case the uncropped file is shared.
const cropShareFile = async (
  path: string,
  crop?: NormalizedCrop,
): Promise<string | null> => {
  if ( !crop || ( crop.w >= FULL_FRAME && crop.h >= FULL_FRAME ) ) return null;
  try {
    const size = await imageFileSize( `file://${path}` );
    if ( !size ) return null;
    const cropped = await cropImageFile(
      path,
      crop,
      size.w,
      size.h,
      TemporaryDirectoryPath,
      1,
      0,
    );
    return stripFilePrefix( cropped );
  } catch ( _e ) {
    return null;
  }
};

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
  const realm = useRealm( );
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
  // of time (see the pre-warm effect below) rather than blocking the share button.
  const buildSharePhoto = useCallback( async ( photoUri: string ): Promise<SharePhotoFile> => {
    // Unique per prep so an in-flight prep for a previous photo can't clobber
    // the file mid-write, which would produce a broken image iOS can't save.
    const tempBase = `${TemporaryDirectoryPath}/share_photo_${Date.now()}`
      + `_${Math.random().toString( 36 ).slice( 2 )}`;
    const tempPath = `${tempBase}.jpg`;

    // Share the untouched original from the device library when there is one,
    // rather than iNaturalist's resized, metadata-stripped copy. Looked up
    // before any await, while the Realm objects are valid.
    const photo = photos.find(
      item => Photo.displayLocalOrRemoteOriginalPhoto( item ) === photoUri,
    );
    const found = photo
      ? findObservationPhoto( realm, {
        uri: Photo.getLocalPhotoUri( photo.localFilePath ),
        url: photo.url,
      } )
      : null;
    if ( found ) {
      // The observation photo is cropped to the saved crop, the original isn't.
      const uploadCrop = Photo.savedNormalizedCrop( found.obsPhoto.photo ) ?? undefined;
      const original = await copyLibraryOriginal( found.library, tempBase );
      if ( original ) return { path: original, uploadCrop };
    }

    // Get a local file we can annotate and share
    if ( photoUri.startsWith( "file://" ) ) {
      await copyFile( stripFilePrefix( photoUri ), tempPath );
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
      exifToWrite.DateTimeOriginal = format(
        new Date( timeObservedAt ),
        "yyyy:MM:dd HH:mm:ss",
      );
    }
    if ( Object.keys( exifToWrite ).length > 0 ) {
      try {
        await Exify.write( `file://${tempPath}`, exifToWrite );
      } catch ( _e ) {
        // Continue sharing even if EXIF write fails
      }
    }

    return { path: tempPath };
  }, [latitude, longitude, photos, realm, timeObservedAt] );

  // Cache of the in-flight/prepared share file for a single photo uri so the
  // share button can present the sheet without waiting on file work.
  const sharePrepRef = useRef<{ uri: string; promise: Promise<SharePhotoFile> } | null>( null );

  const prepareSharePhoto = useCallback( ( photoUri: string ): Promise<SharePhotoFile> => {
    if ( sharePrepRef.current?.uri === photoUri ) {
      return sharePrepRef.current.promise;
    }
    const previous = sharePrepRef.current;
    const promise = buildSharePhoto( photoUri );
    sharePrepRef.current = { uri: photoUri, promise };
    // Clean up the previously prepared temp file once it has finished writing.
    if ( previous ) {
      previous.promise
        .then( ( { path } ) => unlink( path ).catch( ( ) => undefined ) )
        .catch( ( ) => undefined );
    }
    return promise;
  }, [buildSharePhoto] );

  // Pre-warm the shareable copy of the currently displayed photo so tapping
  // the share button can present the share sheet immediately, instead of
  // after the copy/EXIF work finishes. Key off the same uri MainMediaDisplay
  // passes to onSharePhoto so the tap hits the cache rather than rebuilding.
  const currentPhoto = selectedMediaIndex < photos.length
    ? photos[selectedMediaIndex]
    : null;
  const currentShareUri = currentPhoto
    ? Photo.displayLocalOrRemoteOriginalPhoto( currentPhoto )
    : null;
  useEffect( ( ) => {
    if ( !currentShareUri ) return;
    prepareSharePhoto( currentShareUri ).catch( ( ) => undefined );
  }, [currentShareUri, prepareSharePhoto] );

  const handleSharePhoto = useCallback( async ( photoUri: string, crop?: NormalizedCrop ) => {
    let croppedPath: string | null = null;
    try {
      const { path: tempPath, uploadCrop } = await prepareSharePhoto( photoUri );
      // The on-screen crop is of the photo as displayed, i.e. as uploaded.
      croppedPath = await cropShareFile(
        tempPath,
        uploadCrop
          ? cropWithin( uploadCrop, crop )
          : crop,
      );
      // Await so a share failure (e.g. Save Image failing) is actually
      // caught here instead of becoming an unhandled rejection.
      await Share.share( { url: `file://${croppedPath ?? tempPath}` } );
    } catch ( _e ) {
      // Nothing to share if the file could not be prepared or shared
    } finally {
      if ( croppedPath ) unlink( croppedPath ).catch( ( ) => undefined );
    }
  }, [prepareSharePhoto] );

  return (
    <View
      className="flex-1 bg-black"
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
        onSharePhoto={handleSharePhoto}
      />
      <PhotoCameraInfo
        uri={Photo.getLocalPhotoUri( currentPhoto?.localFilePath )}
        url={currentPhoto?.url}
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
    </View>
  );
};

export default MediaViewer;
