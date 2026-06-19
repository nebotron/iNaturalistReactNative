import {
  Button,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";

import ObsPhotoSelectionList from "./ObsPhotoSelectionList";
import SuggestionsModelToggle from "./SuggestionsModelToggle";

interface Props {
  duplicatePhotoUris?: Set<string>;
  onCropPhoto?: ( _uri: string ) => void;
  onPressPhoto: ( _uri: string ) => void;
  onReorderPhotos?: ( _data: { data: string[] } ) => void;
  photoUris: string[];
  selectedPhotoUri: string;
  showModelToggle: boolean;
  toggleSuggestionsModel: ( useOfflineModel: boolean ) => void;
  useOfflineModel: boolean;
  improveWithLocationButtonOnPress: () => void;
  showImproveWithLocationButton: boolean;
}

const SuggestionsHeader = ( {
  duplicatePhotoUris,
  onCropPhoto,
  onPressPhoto,
  onReorderPhotos,
  photoUris,
  selectedPhotoUri,
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
    </>
  );
};

export default SuggestionsHeader;
