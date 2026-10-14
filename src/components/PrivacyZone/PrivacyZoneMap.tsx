import { useNavigation } from "@react-navigation/native";
import LocationPickerContainer from "components/LocationPicker/LocationPickerContainer";
import { List2 } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, { useCallback, useMemo } from "react";
import { Circle } from "react-native-maps";
import { useTranslation } from "sharedHooks";
import useStore from "stores/useStore";
import { getShadow } from "styles/global";
import colors from "styles/tailwindColors";

// Lets the user drop the center of their privacy zone somewhere other than
// where they're standing, which matters because the whole point of the zone is
// usually a place you'd rather not be while setting it up.
const PrivacyZoneMap = ( ) => {
  const { t } = useTranslation( );
  const navigation = useNavigation( );
  const privacyZone = useStore( state => state.privacyZone );
  const { setPrivacyZoneCenter } = privacyZone;

  const hasCenter = privacyZone.latitude != null && privacyZone.longitude != null;

  const pickerObservation = useMemo( ( ) => ( hasCenter
    ? {
      latitude: privacyZone.latitude as number,
      longitude: privacyZone.longitude as number,
      positional_accuracy: privacyZone.radiusMeters,
    }
    : undefined ), [hasCenter, privacyZone.latitude, privacyZone.longitude,
    privacyZone.radiusMeters] );

  const mapChildren = useMemo( ( ) => ( hasCenter
    ? (
      <Circle
        center={{
          latitude: privacyZone.latitude as number,
          longitude: privacyZone.longitude as number,
        }}
        radius={privacyZone.radiusMeters}
        strokeColor={colors.inatGreen}
        fillColor="rgba(116, 172, 0, 0.2)"
      />
    )
    : null ), [hasCenter, privacyZone.latitude, privacyZone.longitude, privacyZone.radiusMeters] );

  const legend = useMemo( ( ) => (
    <View
      className="absolute bottom-5 left-5 bg-white rounded-lg py-2 px-3"
      style={getShadow( )}
      pointerEvents="none"
    >
      <List2>{t( "Current-privacy-zone" )}</List2>
    </View>
  ), [t] );

  const handleSave = useCallback( location => {
    setPrivacyZoneCenter( {
      latitude: location.latitude,
      longitude: location.longitude,
    } );
    navigation.goBack( );
  }, [navigation, setPrivacyZoneCenter] );

  return (
    <LocationPickerContainer
      observation={pickerObservation}
      onSave={handleSave}
      mapChildren={mapChildren}
      legend={hasCenter
        ? legend
        : undefined}
    />
  );
};

export default PrivacyZoneMap;
