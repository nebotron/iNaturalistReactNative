import DevicePhotoImage from "components/PhotoImporter/DevicePhotoImage";
import { applyGroupPhotosPinchCrop } from "components/PhotoImporter/helpers/groupPhotoCrops";
import {
  ActivityIndicator,
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
import { getBrightness } from "sharedHelpers/brightnessLog";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import useTranslation from "sharedHooks/useTranslation";
import colors from "styles/tailwindColors";

interface PhotoItem {
  image: {
    uri: string;
    cropOriginalUri?: string;
    crop?: NormalizedCrop;
  };
  isDuplicateUpload?: boolean;
  pending?: boolean;
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

  // Still being copied out of the device library: the cell stands in for a
  // file the import hasn't written yet (see PhotoLibrary).
  const isPending = photos.length > 0 && photos.every( photo => photo.pending );

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

  // Same selection treatment as combining observations in My Observations
  const selectedOverlay = isSelected && (
    <View
      pointerEvents="none"
      className="absolute inset-0 border-4 border-inatGreen items-end p-1 z-10"
    >
      <INatIcon name="checkmark-circle" size={22} color={String( colors.inatGreen )} />
    </View>
  );

  const cellWidth = typeof style?.width === "number"
    ? style.width
    : 0;

  const renderPhoto = useCallback( ( photo: PhotoItem ) => (
    <DevicePhotoImage
      uri={photo.image.uri}
      cellWidth={cellWidth}
      fitImage
      style={style}
      obsPhotosCount={mediaCount}
      onPress={handlePress}
      // Two fingers pinch and pan the photo; the framing it's left at becomes
      // its crop, exactly as if it had been saved in the crop editor.
      zoomSourceUri={photo.image.cropOriginalUri || photo.image.uri}
      zoomCrop={photo.image.crop}
      // The crop editor bakes its brightness into the cropped file, but the
      // cell draws the untouched original, so the adjustment is redrawn here.
      zoomBrightness={photo.image.cropOriginalUri
        ? getBrightness( photo.image.uri ) ?? 1
        : 1}
      onZoomCropChange={crop => applyGroupPhotosPinchCrop( photo.image.uri, crop )}
      testID={`GroupPhotos.${photo.image.uri}`}
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
  ), [cellWidth, handlePress, mediaCount, style, t] );

  const renderCarouselItem = useCallback(
    ( { item: photo }: { item: object } ) => renderPhoto( photo as PhotoItem ),
    [renderPhoto],
  );

  // A photo the import is still copying shows the device library's own
  // thumbnail, so the grid is populated from the moment it opens; there is no
  // local file to draw at full resolution until the copy lands. Nothing can
  // be done to it yet — combining, cropping and removing all act on a file
  // that doesn't exist — so it draws no buttons and doesn't respond to a tap.
  if ( isPending ) {
    return (
      <View className="relative">
        <DevicePhotoImage
          uri={firstPhoto?.image.uri}
          cellWidth={cellWidth}
          fitImage
          style={style}
          testID={`GroupPhotos.pending.${mediaUri}`}
        />
        <View className="absolute inset-0 items-center justify-center bg-black/20">
          <ActivityIndicator />
        </View>
      </View>
    );
  }

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
            style={style}
          >
            <INatIcon name="sound" size={32} color={colors.darkGray} />
          </View>
        </Pressable>
        {selectedOverlay}
        {actionButtons}
      </View>
    );
  }

  // A group of photos pages horizontally so every photo in it can be seen (and
  // cropped) without separating them first.
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
      {selectedOverlay}
      {actionButtons}
    </View>
  );
};

export default GroupPhotoImage;
