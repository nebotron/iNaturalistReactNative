import MediaViewerModal from "components/MediaViewer/MediaViewerModal";
import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import { INatIcon, INatIconButton } from "components/SharedComponents";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import { Pressable, View } from "components/styledComponents";
import React, {
  useCallback,
  useRef,
  useState,
} from "react";
import type { ViewStyle } from "react-native";
import {
  ActivityIndicator,
  Alert,
} from "react-native";
import extractAudioFromVideo from "sharedHelpers/extractAudioFromVideo";
import useTranslation from "sharedHooks/useTranslation";
import colors from "styles/tailwindColors";

interface PhotoItem {
  image: {
    uri: string;
  };
  isDuplicateUpload?: boolean;
}

interface VideoItem {
  uri: string;
}

interface Item {
  photos?: PhotoItem[];
  videos?: VideoItem[];
}

interface Props {
  item: Item;
  selectedObservations: Item[];
  selectObservationPhotos: ( isSelected: boolean, item: Item ) => void;
  style?: ViewStyle;
}

const GroupPhotoImage = ( {
  item,
  selectedObservations,
  selectObservationPhotos,
  style,
}: Props ) => {
  const { t } = useTranslation( );
  const audioPreviewCacheRef = useRef( new Map<string, string>( ) );
  const [mediaViewerVisible, setMediaViewerVisible] = useState( false );
  const [previewSounds, setPreviewSounds] = useState<{ file_url: string }[]>( [] );
  const [isLoadingPreview, setIsLoadingPreview] = useState( false );
  const isVideoGroup = ( item.videos?.length || 0 ) > 0;
  const firstPhoto = item.photos?.[0];
  const firstVideo = item.videos?.[0];
  const mediaUri = firstPhoto?.image.uri || firstVideo?.uri;
  const isSelected = selectedObservations.includes( item );
  const handlePress = ( ) => selectObservationPhotos( isSelected, item );
  const mediaCount = item.photos?.length || item.videos?.length || 0;
  const hasDuplicateUpload = item.photos?.some( photo => photo.isDuplicateUpload );

  const handlePlayPress = useCallback( async ( ) => {
    const videos = item.videos || [];
    if ( videos.length === 0 || isLoadingPreview ) {
      return;
    }

    setIsLoadingPreview( true );
    try {
      const sounds = await Promise.all(
        videos.map( async ( { uri } ) => {
          let audioUri = audioPreviewCacheRef.current.get( uri );
          if ( !audioUri ) {
            audioUri = await extractAudioFromVideo( uri );
            audioPreviewCacheRef.current.set( uri, audioUri );
          }
          return { file_url: audioUri };
        } ),
      );
      setPreviewSounds( sounds );
      setMediaViewerVisible( true );
    } catch {
      Alert.alert( t( "Something-went-wrong" ) );
    } finally {
      setIsLoadingPreview( false );
    }
  }, [isLoadingPreview, item.videos, t] );

  if ( isVideoGroup ) {
    return (
      <>
        <View
          testID={`GroupPhotos.${mediaUri}`}
          className={`overflow-hidden bg-darkGray ${
            isSelected
              ? "border-4 border-inatGreen"
              : ""
          }`}
          style={style}
        >
          <Pressable
            accessibilityRole="button"
            onPress={handlePress}
            className="flex-1 items-center justify-center"
          >
            <INatIcon name="microphone" size={48} color={colors.white} />
            {mediaCount > 1 && (
              <View className="absolute top-2 right-2 bg-black/60 rounded-full px-2 py-1">
                <INatIcon name="microphone" size={14} color={colors.white} />
              </View>
            )}
          </Pressable>
          <View className="absolute bottom-2 left-0 right-0 items-center">
            {isLoadingPreview
              ? (
                <ActivityIndicator color={colors.white} />
              )
              : (
                <INatIconButton
                  icon="play-circle"
                  onPress={handlePlayPress}
                  mode="contained"
                  color="white"
                  accessibilityLabel="Play"
                  width={44}
                  height={44}
                  size={40}
                />
              )}
          </View>
        </View>
        <MediaViewerModal
          showModal={mediaViewerVisible}
          onClose={( ) => setMediaViewerVisible( false )}
          sounds={previewSounds}
          autoPlaySound
        />
      </>
    );
  }

  const source = firstPhoto && { uri: firstPhoto.image.uri };

  return (
    <Pressable
      accessibilityRole="button"
      onPress={handlePress}
      testID={`GroupPhotos.${mediaUri}`}
    >
      <View className="relative">
        <ObsImagePreview
          source={source}
          selected={isSelected}
          obsPhotosCount={mediaCount}
          selectable
          hideGradientOverlay
          squareCorners
          style={style}
        />
        {hasDuplicateUpload && (
          <DuplicateUploadBadge
            accessibilityLabel={t( "Duplicate-photo-indicator" )}
            className="absolute top-2 left-2 z-10"
            size={20}
            testID={`GroupPhotos.duplicate.${mediaUri}`}
          />
        )}
      </View>
    </Pressable>
  );
};

export default GroupPhotoImage;
