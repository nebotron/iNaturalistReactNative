import {
  Body2,
  Body3,
  Button,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";

import ObsPhotoSelectionList from "./ObsPhotoSelectionList";
import SuggestionsModelToggle from "./SuggestionsModelToggle";

interface Props {
  duplicatePhotoUris?: Set<string>;
  interactionsDisabled: boolean;
  onCropPhoto?: ( _uri: string ) => void;
  onPressPhoto: ( _uri: string ) => void;
  onReorderPhotos?: ( _data: { data: string[] } ) => void;
  photoUris: string[];
  selectedPhotoUri: string;
  showOfflineModelInfo: boolean;
  showModelToggle: boolean;
  toggleSuggestionsModel: ( useOfflineModel: boolean ) => void;
  useOfflineModel: boolean;
  improveWithLocationButtonOnPress: () => void;
  showImproveWithLocationButton: boolean;
}

const SuggestionsHeader = ( {
  duplicatePhotoUris,
  interactionsDisabled,
  onCropPhoto,
  onPressPhoto,
  onReorderPhotos,
  photoUris,
  selectedPhotoUri,
  showOfflineModelInfo,
  showModelToggle,
  toggleSuggestionsModel,
  useOfflineModel,
  improveWithLocationButtonOnPress,
  showImproveWithLocationButton,
}: Props ) => {
  const { t } = useTranslation( );

  return (
    <>
      <View className="mx-5">
        <ObsPhotoSelectionList
          duplicatePhotoUris={duplicatePhotoUris}
          onCropPhoto={onCropPhoto}
          photoUris={photoUris}
          selectedPhotoUri={selectedPhotoUri}
          onPressPhoto={onPressPhoto}
          onReorderPhotos={onReorderPhotos}
        />
      </View>
      {showModelToggle && (
        <SuggestionsModelToggle
          disabled={interactionsDisabled}
          onModelChange={toggleSuggestionsModel}
          useOfflineModel={useOfflineModel}
        />
      )}
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
        <View className="border-lightGray border-[3px] m-5 rounded-2xl p-5">
          <Body2 className="mb-2">{t( "Viewing-offline-suggestions" )}</Body2>
          <Body3>{t( "Offline-suggestions-may-differ-from-online" )}</Body3>
        </View>
      )}
    </>
  );
};

export default SuggestionsHeader;
