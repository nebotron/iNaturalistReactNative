// @flow

import MediaViewerModal from "components/MediaViewer/MediaViewerModal";
import MasonryLayout from "components/ObsDetails/MasonryLayout";
import { ActivityIndicator, Carousel } from "components/SharedComponents";
import {
  FasterImageView, Pressable, View,
} from "components/styledComponents";
import type { Node } from "react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useWindowDimensions } from "react-native";
import LinearGradient from "react-native-linear-gradient";
import Photo from "realmModels/Photo";

type Props = {
  loading: boolean,
  onChangeIndex?: Function,
  photos: {
    id?: number,
    url: string,
    localFilePath?: string,
    attribution?: string,
    licenseCode?: string
  }[],
  tablet: boolean
}

const TaxonMedia = ( {
  loading,
  onChangeIndex,
  photos = [],
  sounds = [],
  tablet,
}: Props ): Node => {
  const { width } = useWindowDimensions( );
  const [index, setIndex] = useState( 0 );
  const [mediaViewerVisible, setMediaViewerVisible] = useState( false );

  const items = useMemo( ( ) => ( [...photos, ...sounds] ), [photos, sounds] );
  const slideStyle = useMemo( ( ) => ( {
    width,
    height: 420,
  } ), [width] );

  const CarouselSlide = useCallback(
    ( { item } ) => (
      <Pressable
        accessibilityRole="button"
        onPress={() => { setMediaViewerVisible( true ); }}
        accessibilityState={{ disabled: false }}
        style={slideStyle}
      >
        <LinearGradient
          colors={["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0.5) 100%)"]}
          className="absolute w-full h-full z-10"
        />
        <FasterImageView
          testID={`TaxonDetails.photo.${item.id}`}
          className="w-full h-full"
          source={{
            url: Photo.displayLargePhoto( item.url ),
            cachePolicy: "discWithCacheControl",
            resizeMode: "cover",
          }}
          accessibilityIgnoresInvertColors
        />
      </Pressable>
    ),
    [setMediaViewerVisible, slideStyle],
  );

  useEffect( ( ) => {
    if ( onChangeIndex ) {
      onChangeIndex( index );
    }
  }, [index, onChangeIndex] );

  const currentPhotoUrl = index >= photos.length
    ? undefined
    : photos[index]?.url;

  const loadingIndicator = (
    <View className="h-[288px] w-full items-center justify-center">
      <ActivityIndicator
        className="absolute"
      />
    </View>
  );

  const renderPhone = ( ) => (
    loading
      ? loadingIndicator
      : (
        <Carousel
          testID="photo-scroll"
          data={items}
          renderItem={CarouselSlide}
          onSlideScroll={setIndex}
          style={{ width }}
        />
      )
  );

  const renderTablet = () => (
    <View className="w-full h-full">
      <MasonryLayout
        items={items}
        onImagePress={newIndex => {
          setIndex( newIndex );
          setMediaViewerVisible( true );
        }}
      />
    </View>
  );

  return (
    <View className="relative">
      {!tablet
        ? renderPhone( )
        : renderTablet( )}
      <MediaViewerModal
        showModal={mediaViewerVisible}
        onClose={( ) => setMediaViewerVisible( false )}
        uri={currentPhotoUrl}
        photos={photos}
      />
    </View>
  );
};

export default TaxonMedia;
