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
  showOfflineModelInfo,
  toggleSuggestionsModel,
  improveWithLocationButtonOnPress,
  showImproveWithLocationButton,
}: Props ) => {
  const { t } = useTranslation( );

  return (
    <>
      <View className="mx-5">
        {soundUri
          ? <SoundContainer sizeClass="w-full h-[188px]" sound={{ file_url: soundUri }} isVisible />
          : (
            <ObsPhotoSelectionList
              detectSubject={detectSubject}
              onCropPhoto={onCropPhoto}
              photoUris={photoUris}
              selectedPhotoUri={selectedPhotoUri}
              onPressPhoto={onPressPhoto}
              onReorderPhotos={onReorderPhotos}
            />
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
