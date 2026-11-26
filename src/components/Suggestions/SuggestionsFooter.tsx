import {
  Body1,
  Button,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import Attribution from "components/Suggestions/Attribution";
import React from "react";
import { useTranslation } from "sharedHooks";
import useStore from "stores/useStore";

interface Props {
  handleSkip: ( ) => void;
  hideLocationToggleButton: boolean;
  hideSkip?: boolean;
  observers: string[];
  // Offers cropping the selected photo when this is passed
  onCropPhoto?: ( ) => void;
  shouldUseEvidenceLocation: boolean;
  toggleLocation: ( options: { showLocation: boolean } ) => void;
}

const SuggestionsFooter = ( {
  handleSkip,
  hideLocationToggleButton,
  hideSkip,
  observers,
  onCropPhoto,
  shouldUseEvidenceLocation,
  toggleLocation,
}: Props ) => {
  const { t } = useTranslation( );
  const bulkUploadMode = useStore( state => state.bulkUploadMode );

  return (
    <View className="mb-9">
      {( !hideLocationToggleButton || onCropPhoto ) && (
        <View className="px-4 py-6">
          {!hideLocationToggleButton && (
            shouldUseEvidenceLocation
              ? (
                <Button
                  text={t( "IGNORE-LOCATION" )}
                  onPress={( ) => toggleLocation( { showLocation: false } )}
                  accessibilityLabel={t( "Search-suggestions-without-location" )}
                />
              )
              : (
                <Button
                  text={t( "USE-LOCATION" )}
                  onPress={( ) => toggleLocation( { showLocation: true } )}
                  accessibilityLabel={t( "Search-suggestions-with-location" )}
                />
              )
          )}
          {onCropPhoto && (
            <Button
              className={!hideLocationToggleButton
                ? "mt-4"
                : undefined}
              text={t( "CROP-PHOTO" )}
              onPress={onCropPhoto}
              accessibilityLabel={t( "Crop-photo" )}
            />
          )}
        </View>
      )}
      {!hideLocationToggleButton && <Attribution observers={observers} />}
      { !hideSkip && bulkUploadMode && (
        <View className="px-4 py-6">
          <Button
            text={t( "SKIP-LEAVE-UNKNOWN" )}
            onPress={handleSkip}
            accessibilityHint={t( "Skips-this-observation-and-leaves-it-unknown" )}
          />
        </View>
      ) }
      { !hideSkip && !bulkUploadMode && (
        <Body1
          className="underline text-center py-6"
          onPress={handleSkip}
          accessibilityRole="link"
          accessibilityHint={t( "Navigates-to-observation-edit-screen" )}
        >
          {t( "Add-an-ID-Later" )}
        </Body1>
      ) }
    </View>
  );
};
export default SuggestionsFooter;
