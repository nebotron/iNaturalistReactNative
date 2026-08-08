import DevicePhotoImage from "components/PhotoImporter/DevicePhotoImage";
import GroupPhotoCropImage from "components/PhotoImporter/GroupPhotoCropImage";
import {
  groupPhotoCropSourceUri,
  saveGroupPhotoCrop,
} from "components/PhotoImporter/helpers/groupPhotoCrops";
import groupPhotoThumbnailMaxPixel from "components/PhotoImporter/helpers/groupPhotoThumbnail";
import {
  Carousel,
  CarouselDots,
  INatIcon,
  INatIconButton,
} from "components/SharedComponents";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import { Pressable, View } from "components/styledComponents";
import React, { useCallback, useState } from "react";
import type { ViewStyle } from "react-native";
import { StyleSheet } from "react-native";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import useTranslation from "sharedHooks/useTranslation";
import colors from "styles/tailwindColors";

const styles = StyleSheet.create( {
  selectedBorder: {
    borderWidth: 4,
    borderColor: colors.inatGreen,
  },
} );

interface PhotoItem {
  image: {
    uri: string;
    cropOriginalUri?: string;
    crop?: NormalizedCrop;
  };
  isDuplicateUpload?: boolean;
}

interface Item {
  photos?: PhotoItem[];
  soundUri?: string;
}

interface Props {
  duplicateItem: ( item: Item ) => void;
  isDuplicatingPhotos?: boolean;
  item: Item;
  removeItem: ( item: Item ) => void;
  selectedObservations: Item[];
  selectObservationPhotos: ( isSelected: boolean, item: Item ) => void;
  separateItem: ( item: Item ) => void;
  style?: ViewStyle;
}

const GroupPhotoImage = ( {
  duplicateItem,
  isDuplicatingPhotos,
  item,
  removeItem,
  selectedObservations,
  selectObservationPhotos,
  separateItem,
  style,
}: Props ) => {
  const { t } = useTranslation( );
  const photos = item.photos ?? [];
  const firstPhoto = photos[0];
  const mediaUri = firstPhoto?.image.uri ?? item.soundUri;
  const [photoIndex, setPhotoIndex] = useState( 0 );
  const [prevMediaUri, setPrevMediaUri] = useState( mediaUri );

  // Reset the pager when a recycled cell lands on a different observation
  if ( prevMediaUri !== mediaUri ) {
    setPrevMediaUri( mediaUri );
    setPhotoIndex( 0 );
  }

  const isSelected = selectedObservations.includes( item );
  const handlePress = useCallback(
    ( ) => selectObservationPhotos( isSelected, item ),
    [isSelected, item, selectObservationPhotos],
  );
  const mediaCount = photos.length;

  // Each grid cell carries its own separate/duplicate/remove buttons so the
  // action always applies to the photo it's drawn on, not to the selection.
  const separableItemCount = mediaCount + ( item.soundUri
    ? 1
    : 0 );
  const actionButtons = (
    <View className="absolute bottom-2 left-2 flex-row gap-2 z-20">
      {separableItemCount > 1 && (
        <INatIconButton
          icon="separate"
          mode="contained"
          size={20}
          width={44}
          height={44}
          color={colors.white}
          backgroundColor={colors.darkGray}
          accessibilityLabel={t( "Separate-Photos" )}
          onPress={( ) => separateItem( item )}
          testID={`GroupPhotos.separate.${mediaUri}`}
        />
      )}
      {mediaCount > 0 && (
        <INatIconButton
          icon="copy"
          mode="contained"
          size={20}
          width={44}
          height={44}
          color={colors.white}
          backgroundColor={colors.darkGray}
          accessibilityLabel={t( "Duplicate-Photos" )}
          disabled={isDuplicatingPhotos}
          onPress={( ) => duplicateItem( item )}
          testID={`GroupPhotos.duplicate.${mediaUri}`}
        />
      )}
      <INatIconButton
        icon="trash-outline"
        mode="contained"
        size={20}
        width={44}
        height={44}
        color={colors.white}
        backgroundColor={colors.warningRed}
        accessibilityLabel={t( "Remove-Photos" )}
        onPress={( ) => removeItem( item )}
        testID={`GroupPhotos.remove.${mediaUri}`}
      />
    </View>
  );

  const cellWidth = typeof style?.width === "number"
    ? style.width
    : 0;

  // Pinching a cell reframes its crop box, exactly as it does in the Explore
  // observation grid. The crop is recorded against the photo (the file itself
  // is written at import time), so the framing survives scrolling away and
  // carries into the full-screen cropper.
  const renderPhoto = useCallback( ( photo: PhotoItem ) => (
    <DevicePhotoImage
      uri={photo.image.uri}
      // A cropped photo must always show its crop, so fall back to the cropped
      // file (image.uri already points at the baked crop) until the thumbnail
      // is ready rather than flashing a placeholder. Large uncropped originals
      // keep waiting on the thumbnail so scrolling doesn't decode them
      // full-resolution.
      fallbackUri={photo.image.crop
        ? photo.image.uri
        : undefined}
      cellWidth={cellWidth}
      // The same size the whole import is preloaded at and detects its
      // subject in. Asking for the cell's own 1x size instead meant a second
      // file per photo that nothing warmed, so a photo reached by scrolling
      // had to generate it there and then — which is why cells that had
      // already been shown went back to a placeholder.
      thumbnailMaxPixel={cellWidth > 0
        ? groupPhotoThumbnailMaxPixel( cellWidth )
        : undefined}
      style={style}
      selectable
      selected={isSelected}
      obsPhotosCount={mediaCount}
      onPress={handlePress}
      testID={`GroupPhotos.${photo.image.uri}`}
      imageOverlay={cellWidth > 0
        ? (
          <GroupPhotoCropImage
            cropSourceUri={groupPhotoCropSourceUri( photo.image )}
            savedCrop={photo.image.crop ?? null}
            size={cellWidth}
            onCropChange={( crop: NormalizedCrop ) => saveGroupPhotoCrop( photo.image.uri, crop )}
          />
        )
        : undefined}
    >
      {photo.isDuplicateUpload && (
        <DuplicateUploadBadge
          accessibilityLabel={t( "Duplicate-photo-indicator" )}
          className="absolute top-2 left-2 z-10"
          size={20}
          testID={`GroupPhotos.duplicateUpload.${photo.image.uri}`}
        />
      )}
    </DevicePhotoImage>
  ), [cellWidth, handlePress, isSelected, mediaCount, style, t] );

  const renderCarouselItem = useCallback(
    ( { item: photo }: { item: object } ) => renderPhoto( photo as PhotoItem ),
    [renderPhoto],
  );

  if ( item.soundUri ) {
    return (
      <View className="relative">
        <Pressable
          accessibilityRole="button"
          onPress={handlePress}
          testID={`GroupPhotos.${mediaUri}`}
        >
          <View
            className="items-center justify-center bg-lightGray"
            style={[style, isSelected && styles.selectedBorder]}
          >
            <INatIcon name="sound" size={32} color={colors.darkGray} />
          </View>
        </Pressable>
        {actionButtons}
      </View>
    );
  }

  // A group of photos pages horizontally so every photo in it can be seen (and
  // cropped) without separating them first. The crop overlay leaves
  // single-finger panning to the pager, so a horizontal drag swipes photos and
  // a vertical one still scrolls the list.
  return (
    <View className="relative">
      {mediaCount > 1
        ? (
          <>
            <Carousel
              key={mediaUri}
              data={photos}
              renderItem={renderCarouselItem}
              keyExtractor={photo => ( photo as PhotoItem ).image.uri}
              style={style}
              // Each page carries its own subject detection and thumbnail
              // work, so only the pages next to the visible one are mounted
              initialNumToRender={1}
              windowSize={3}
              onSlideScroll={setPhotoIndex}
              testID={`GroupPhotos.carousel.${mediaUri}`}
            />
            <View className="absolute bottom-0 w-full z-10">
              <CarouselDots
                length={mediaCount}
                index={Math.min( photoIndex, mediaCount - 1 )}
              />
            </View>
          </>
        )
        : firstPhoto && renderPhoto( firstPhoto )}
      {actionButtons}
    </View>
  );
};

export default GroupPhotoImage;
