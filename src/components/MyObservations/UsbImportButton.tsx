import { useFocusEffect } from "@react-navigation/native";
import { INatIconButton } from "components/SharedComponents";
import React, { useCallback } from "react";
import { AppState } from "react-native";
import {
  isUsbImportSupported,
  refreshUsbCardState,
} from "sharedHelpers/usbStorage";
import { useTranslation } from "sharedHooks";
import useUsbImportProgress from "stores/usbImportProgress";
import colors from "styles/tailwindColors";

// iOS gives no notice of a drive being attached, so while the card reads as
// empty and this screen is in front, look again now and then for a new one.
const EMPTY_CARD_RECHECK_MS = 10_000;

// Starts a USB import (useUsbImport). Hidden until a folder is chosen in
// Settings; disabled once the import is done and the card is empty.
const UsbImportButton = ( ) => {
  const { t } = useTranslation( );
  const cardState = useUsbImportProgress( state => state.cardState );
  const importing = useUsbImportProgress( state => state.active );
  const startImport = useUsbImportProgress( state => state.startImport );

  useFocusEffect( useCallback( ( ) => {
    if ( cardState !== "empty" ) return ( ) => undefined;
    const interval = setInterval( ( ) => {
      if ( AppState.currentState === "active" ) void refreshUsbCardState( );
    }, EMPTY_CARD_RECHECK_MS );
    return ( ) => clearInterval( interval );
  }, [cardState] ) );

  if ( !isUsbImportSupported( ) || cardState === "unconfigured" ) return null;
  const disabled = cardState === "empty" || importing;
  return (
    <INatIconButton
      icon={disabled
        ? "arrow-down-bold-circle-outline"
        : "arrow-down-bold-circle"}
      className="mr-[7px]"
      onPress={( ) => { void startImport?.( ); }}
      disabled={disabled}
      color={String( disabled
        ? colors?.darkGray
        : colors?.inatGreen )}
      accessibilityLabel={t( "Import-photos-from-USB" )}
      accessibilityHint={t( "Imports-new-photos-from-USB" )}
      size={22}
      testID="UsbImportButton"
    />
  );
};

export default UsbImportButton;
