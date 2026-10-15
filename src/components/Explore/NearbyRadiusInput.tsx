import { Body2, Body3 } from "components/SharedComponents";
import { TextInput, View } from "components/styledComponents";
import React, { useCallback, useEffect, useState } from "react";
import {
  MAX_NEARBY_RADIUS_KM,
  parseNearbyRadiusKm,
} from "sharedHelpers/nearbyRadius";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

export interface NearbyRadiusConfig {
  selected: boolean;
  radiusKm: number;
  defaultRadiusKm: number;
  onChange: ( radiusKm: number ) => void;
}

type Props = Omit<NearbyRadiusConfig, "selected">;

const NearbyRadiusInput = ( {
  radiusKm: nearbyRadiusKm, defaultRadiusKm, onChange,
}: Props ) => {
  const { t } = useTranslation( );
  const [radiusText, setRadiusText] = useState( String( nearbyRadiusKm ) );
  const [isFocused, setIsFocused] = useState( false );

  useEffect( ( ) => {
    if ( !isFocused ) {
      setRadiusText( String( nearbyRadiusKm ) );
    }
  }, [isFocused, nearbyRadiusKm] );

  const commitRadius = useCallback( ( text: string ) => {
    const radius = parseNearbyRadiusKm( text, defaultRadiusKm );
    setRadiusText( String( radius ) );
    onChange( radius );
  }, [defaultRadiusKm, onChange] );

  return (
    <View className="mt-4 px-6 pb-2" testID="nearby-radius-input">
      <Body2 className="mb-2">{t( "Nearby-search-radius" )}</Body2>
      <View className="flex-row items-center">
        <TextInput
          accessibilityLabel={t( "Nearby-search-radius" )}
          className="border border-lightGray h-10 flex-1 rounded-xl px-3 text-base"
          keyboardType="number-pad"
          maxLength={String( MAX_NEARBY_RADIUS_KM ).length}
          onBlur={() => {
            commitRadius( radiusText );
            setIsFocused( false );
          }}
          onChangeText={text => {
            setRadiusText( text.replace( /\D/g, "" ) );
          }}
          onFocus={() => setIsFocused( true )}
          onSubmitEditing={() => commitRadius( radiusText )}
          placeholder={String( defaultRadiusKm )}
          placeholderTextColor={colors.darkGray}
          returnKeyType="done"
          testID="nearby-radius-km-input"
          value={radiusText}
        />
        {/* eslint-disable-next-line i18next/no-literal-string */}
        <Body3 className="ml-3">km</Body3>
      </View>
    </View>
  );
};

export default NearbyRadiusInput;
