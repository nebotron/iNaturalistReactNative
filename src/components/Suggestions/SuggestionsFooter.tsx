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
  shouldUseEvidenceLocation: boolean;
  toggleLocation: ( options: { showLocation: boolean } ) => void;
}

const SuggestionsFooter = ( {
  handleSkip,
  hideLocationToggleButton,
  hideSkip,
  observers,
  shouldUseEvidenceLocation,
  toggleLocation,
}: Props ) => {
  const { t } = useTranslation( );
  const bulkUploadMode = useStore( state => state.bulkUploadMode );

  return (
    <View className="mb-9">
      {!hideLocationToggleButton && (
        <>
          <View className="px-4 py-6">
            {shouldUseEvidenceLocation
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

              )}
          </View>
          <Attribution observers={observers} />
        </>
      )}
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
