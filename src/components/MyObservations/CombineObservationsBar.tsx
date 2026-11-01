import {
  ActivityIndicator,
  Body1,
  INatIconButton,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useEffect, useState } from "react";
import { Alert } from "react-native";
import combineObservations from "sharedHelpers/combineObservations";
import { useTranslation } from "sharedHooks";
import useStore from "stores/useStore";
import { getShadow } from "styles/global";
import colors from "styles/tailwindColors";

const { useRealm } = RealmContext;

const DROP_SHADOW = getShadow( { offsetHeight: -2 } );

// Shown while observations are selected (by long pressing one) so they can be combined
const CombineObservationsBar = ( ) => {
  const { t } = useTranslation( );
  const realm = useRealm( );
  const selection = useStore( state => state.combineSelection );
  const setCombineSelection = useStore( state => state.setCombineSelection );
  const [combining, setCombining] = useState( false );

  // Leaving My Observations ends the selection
  useEffect( ( ) => ( ) => setCombineSelection( null ), [setCombineSelection] );

  if ( !selection ) return null;

  const combine = async ( ) => {
    setCombining( true );
    try {
      await combineObservations( realm, selection );
      setCombineSelection( null );
    } catch ( error ) {
      Alert.alert( t( "Couldnt-combine-observations" ), ( error as Error ).message );
    } finally {
      setCombining( false );
    }
  };

  const confirmCombine = ( ) => Alert.alert(
    t( "Combine-x-observations", { count: selection.length } ),
    t( "Combine-observations-explanation" ),
    [
      { text: t( "Cancel" ), style: "cancel" },
      { text: t( "Combine-Observations" ), onPress: combine },
    ],
  );

  return (
    <View
      className="absolute bottom-0 w-full bg-white z-50 flex-row items-center px-4 pt-2 pb-4"
      style={DROP_SHADOW}
    >
      <INatIconButton
        icon="close"
        accessibilityLabel={t( "Cancel" )}
        onPress={( ) => setCombineSelection( null )}
        disabled={combining}
      />
      <Body1 className="flex-1 text-center">
        {t( "X-selected", { count: selection.length } )}
      </Body1>
      {combining
        ? <ActivityIndicator size={58} />
        : (
          <INatIconButton
            icon="combine"
            mode="contained"
            size={26}
            width={58}
            height={58}
            color={colors.white}
            backgroundColor={colors.darkGray}
            accessibilityLabel={t( "Combine-Observations" )}
            disabled={selection.length < 2}
            onPress={confirmCombine}
            testID="MyObservations.combine"
          />
        )}
    </View>
  );
};

export default CombineObservationsBar;
