import { Button } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";

interface Props {
  disabled?: boolean;
  onModelChange: ( useOfflineModel: boolean ) => void;
  useOfflineModel: boolean;
}

const SuggestionsModelToggle = ( {
  disabled = false,
  onModelChange,
  useOfflineModel,
}: Props ) => {
  const { t } = useTranslation( );

  return (
    <View className="mx-5 mt-5 flex-row">
      <Button
        className="grow mr-2"
        disabled={disabled}
        level={useOfflineModel
          ? "neutral"
          : "focus"}
        onPress={() => onModelChange( false )}
        text={t( "Online-suggestions" )}
        accessibilityLabel={t( "Online-suggestions" )}
        accessibilityState={{ selected: !useOfflineModel }}
      />
      <Button
        className="grow"
        disabled={disabled}
        level={useOfflineModel
          ? "focus"
          : "neutral"}
        onPress={() => onModelChange( true )}
        text={t( "Offline-suggestions" )}
        accessibilityLabel={t( "Offline-suggestions" )}
        accessibilityState={{ selected: useOfflineModel }}
      />
    </View>
  );
};

export default SuggestionsModelToggle;
