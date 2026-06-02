// @flow

import { WarningSheet } from "components/SharedComponents";
import type { Node } from "react";
import React from "react";
import useTranslation from "sharedHooks/useTranslation";

type Props = {
  onAddLocation: ( ) => void,
  onSkip: ( ) => void,
  onClose: ( ) => void,
}

const AddLocationForIDSheet = ( { onAddLocation, onSkip, onClose }: Props ): Node => {
  const { t } = useTranslation( );

  return (
    <WarningSheet
      headerText={t( "ADD-LOCATION-FOR-BETTER-IDS" )}
      text={t( "Improve-suggestions-by-using-your-location" )}
      buttonText={t( "Add-Location" )}
      buttonType="focus"
      confirm={onAddLocation}
      secondButtonText={t( "Skip-for-now" )}
      handleSecondButtonPress={onSkip}
      onPressClose={onClose}
      loading={false}
    />
  );
};

export default AddLocationForIDSheet;
