import ActivityIndicator from "components/SharedComponents/ActivityIndicator";
import { View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";
import { getShadow } from "styles/global";

const DROP_SHADOW = getShadow( {
  offsetHeight: 2,
  elevation: 4,
} );

interface Props {
  className?: string;
  testID?: string;
}

// A small spinner in a corner of the map while results load, rather than one
// covering it, so the map and what it already shows stay usable
const MapLoadingIndicator = ( { className = "top-5 right-5", testID }: Props ) => {
  const { t } = useTranslation( );
  return (
    <View
      className={`absolute z-10 bg-white rounded-full p-2 ${className}`}
      style={DROP_SHADOW}
      pointerEvents="none"
      accessible
      accessibilityLabel={t( "Loading-results" )}
      accessibilityRole="progressbar"
      testID={testID}
    >
      <ActivityIndicator size={20} />
    </View>
  );
};

export default MapLoadingIndicator;
