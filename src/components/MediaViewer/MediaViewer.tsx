import Clipboard from "@react-native-clipboard/clipboard";
import {
  downloadFile,
  readFile,
  TemporaryDirectoryPath,
} from "@dr.pogodin/react-native-fs";
import {
  Body2,
  BottomSheet,
  Button,
  INatIcon,
  WarningSheet,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Platform, StatusBar } from "react-native";
import type { ICarouselInstance } from "react-native-reanimated-carousel";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Photo from "realmModels/Photo";
import { BREAKPOINTS } from "sharedHelpers/breakpoint";
import useDeviceOrientation from "sharedHooks/useDeviceOrientation";
import useTranslation from "sharedHooks/useTranslation";
import { getShadow } from "styles/global";
import colors from "styles/tailwindColors";

import MainMediaDisplay from "./MainMediaDisplay";
import MediaSelector from "./MediaSelector";
import MediaViewerHeader from "./MediaViewerHeader";

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
  editable?: boolean;
  deleting?: boolean;
  // Optional component to use as the header
  header?: (
    { onClose, photoCount }: { onClose: ( ) => void; photoCount: number}
  ) => React.JSX.Element;
  initialIndex?: number;
  onClose?: ( ) => void;
  onCropPhoto?: Function;
  onDeletePhoto?: ( uri: string ) => void;
  onDeleteSound?: ( uri: string ) => void;
  onReorderPhotos?: Function;
  photos?: PhotoItem[];
  sounds?: SoundItem[];
  uri?: string | null;
}

const MediaViewer = ( {
  autoPlaySound,
  editable,
  deleting,
  header,
  initialIndex,
  onClose = ( ) => undefined,
  onCropPhoto,
  onDeletePhoto,
  onDeleteSound,
  onReorderPhotos,
  photos = [],
  sounds = [],
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
  const [uriToCopy, setUriToCopy] = useState<string | null>( null );
  const [showCopyPhotoSheet, setShowCopyPhotoSheet] = useState( false );
  const [photoCopied, setPhotoCopied] = useState( false );

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
      horizontalScroll?.current?.scrollToIndex( {
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
    if ( uris.length > 0 && selectedMediaIndex >= uris.length ) {
      const newIndex = Math.max( 0, selectedMediaIndex - 1 );
      setSelectedMediaIndex( newIndex );
      horizontalScroll?.current?.scrollTo( {
        index: newIndex,
        animated: false,
      } );
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

  const handleLongPressPhoto = useCallback( ( uri: string ) => {
    setUriToCopy( uri );
    setShowCopyPhotoSheet( true );
  }, [] );

  const handleCopyPhoto = useCallback( async ( ) => {
    if ( !uriToCopy ) return;
    setShowCopyPhotoSheet( false );
    try {
      if ( Platform.OS === "ios" ) {
        let base64: string;
        if ( uriToCopy.startsWith( "file://" ) ) {
          base64 = await readFile( uriToCopy.replace( "file://", "" ), "base64" );
        } else {
          const tempPath = `${TemporaryDirectoryPath}/clipboard_photo.jpg`;
          await downloadFile( { fromUrl: uriToCopy, toFile: tempPath } ).promise;
          base64 = await readFile( tempPath, "base64" );
        }
        Clipboard.setImage( base64 );
      } else {
        Clipboard.setString( uriToCopy );
      }
    } catch ( _e ) {
      Clipboard.setString( uriToCopy );
    }
    setPhotoCopied( true );
    setTimeout( ( ) => setPhotoCopied( false ), 2000 );
  }, [uriToCopy] );

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
      {showCopyPhotoSheet && (
        <BottomSheet
          onPressClose={( ) => setShowCopyPhotoSheet( false )}
          insideModal
        >
          <View className="p-5">
            <Button
              text={t( "Copy-photo" )}
              onPress={handleCopyPhoto}
            />
          </View>
        </BottomSheet>
      )}
      {photoCopied && (
        <View
          className="absolute inset-0 items-center justify-center"
          pointerEvents="none"
        >
          <View
            className="bg-white p-3 rounded-xl flex-row items-center"
            style={getShadow( )}
          >
            <Body2 className="mr-3">{t( "Photo-copied-to-clipboard" )}</Body2>
            <INatIcon
              name="checkmark-circle"
              size={19}
              color={colors.inatGreen}
            />
          </View>
        </View>
      )}
    </View>
  );
};

export default MediaViewer;
