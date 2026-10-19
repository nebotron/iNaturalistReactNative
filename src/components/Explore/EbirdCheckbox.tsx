import { isEbirdEnabled } from "api/ebird";
import { Checkbox } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";
import useStore from "stores/useStore";

const EbirdCheckbox = ( ) => {
  const { t } = useTranslation( );
  const ebirdEnabled = useStore( state => state.layout.ebirdEnabled );
  const setEbirdEnabled = useStore( state => state.layout.setEbirdEnabled );
  if ( !isEbirdEnabled( ) ) return null;
  return (
    <View className="mb-7">
      <Checkbox
        accessibilityLabel={t( "Include-eBird-sightings" )}
        text={t( "Include-eBird-sightings" )}
        isChecked={ebirdEnabled}
        onPress={( ) => setEbirdEnabled( !ebirdEnabled )}
      />
    </View>
  );
};

export default EbirdCheckbox;
