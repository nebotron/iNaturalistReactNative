import classnames from "classnames";
import { INatIconButton } from "components/SharedComponents";
import React from "react";
import useTranslation from "sharedHooks/useTranslation";
import { getShadow } from "styles/global";

const DROP_SHADOW = getShadow( );

interface Props {
  // Distance from the bottom of the map, overriding the className's bottom-5
  bottomOffset?: number;
  currentLocationButtonClassName?: string;
  onPress: () => void;
  showCurrentLocationButton?: boolean;
  renderPermissionsGate: () => React.JSX.Element;
}

const CurrentLocationButton = ( {
  bottomOffset,
  currentLocationButtonClassName,
  onPress,
  showCurrentLocationButton,
  renderPermissionsGate,
}: Props ) => {
  const { t } = useTranslation( );
  if ( !showCurrentLocationButton ) {
    return null;
  }
  return (
    <>
      <INatIconButton
        icon="location-arrow"
        className={classnames(
          "absolute bg-white rounded-full",
          currentLocationButtonClassName || "bottom-5 right-5",
        )}
        style={bottomOffset === undefined
          ? DROP_SHADOW
          : { ...DROP_SHADOW, bottom: bottomOffset }}
        accessibilityLabel={t( "Zoom-to-current-location" )}
        onPress={onPress}
        testID="Map.CurrentLocationButton"
      />
      {renderPermissionsGate( )}
    </>
  );
};

export default CurrentLocationButton;
