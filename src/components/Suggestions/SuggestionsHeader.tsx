import classnames from "classnames";
import SoundContainer from "components/ObsDetailsSharedComponents/Media/SoundContainer";
import {
  Body2,
  Body3,
  Button,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";

import ObsPhotoSelectionList from "./ObsPhotoSelectionList";

interface Props {
  detectSubject?: boolean;
  onCropPhoto?: ( _uri: string ) => void;
  onPressPhoto: ( _uri: string ) => void;
  onReorderPhotos?: ( _data: { data: string[] } ) => void;
  photoUris: string[];
  selectedPhotoUri: string;
  soundUri?: string;
  soundUris?: string[];
  onPressSound?: ( _uri: string ) => void;
  showOfflineModelInfo: boolean;
  toggleSuggestionsModel: ( useOfflineModel: boolean ) => void;
  improveWithLocationButtonOnPress: () => void;
  showImproveWithLocationButton: boolean;
}

const SuggestionsHeader = ( {
  detectSubject,
  onCropPhoto,
  onPressPhoto,
  onReorderPhotos,
  photoUris,
  selectedPhotoUri,
  soundUri,
  soundUris = [],
  onPressSound,
  showOfflineModelInfo,
  toggleSuggestionsModel,
  improveWithLocationButtonOnPress,
  showImproveWithLocationButton,
}: Props ) => {
  const { t } = useTranslation( );
  const hasMultipleMedia = photoUris.length + soundUris.length > 1;

  return (
    <>
      <View className="mx-5">
        {/* With only one piece of evidence there's nothing to pick between, so
            a lone sound gets just its player. Otherwise every photo and sound
            sits in the thumbnail strip, with the selected sound's player
            below it. */}
        {( hasMultipleMedia || !soundUri ) && (
          <ObsPhotoSelectionList
            detectSubject={detectSubject}
            onCropPhoto={onCropPhoto}
            photoUris={photoUris}
            selectedPhotoUri={selectedPhotoUri}
            onPressPhoto={onPressPhoto}
            onReorderPhotos={onReorderPhotos}
            soundUris={soundUris}
            selectedSoundUri={soundUri}
            onPressSound={onPressSound}
          />
        )}
        {soundUri && (
          <View
            className={classnames(
              "bg-black rounded-lg overflow-hidden",
              { "mt-3": hasMultipleMedia },
            )}
          >
            <SoundContainer
              key={soundUri}
              sizeClass="w-full py-4"
              sound={{ file_url: soundUri }}
              isVisible
            />
          </View>
        )}
      </View>
      {showImproveWithLocationButton && (
        <View className="mx-5 mt-5">
          <Button
            text={t( "IMPROVE-THESE-SUGGESTIONS-BY-USING-YOUR-LOCATION" )}
            accessibilityHint={t( "Opens-location-permission-prompt" )}
            level="focus"
            onPress={improveWithLocationButtonOnPress}
          />
        </View>
      )}
      {showOfflineModelInfo && (
        <Pressable
          accessibilityRole="button"
          className="border-lightGray border-[3px] m-5 rounded-2xl p-5"
          onPress={() => toggleSuggestionsModel( false )}
        >
          <Body2 className="mb-2">{t( "Viewing-offline-suggestions" )}</Body2>
          <Body3>{t( "Offline-suggestions-may-differ-from-online" )}</Body3>
        </Pressable>
      )}
    </>
  );
};

export default SuggestionsHeader;
