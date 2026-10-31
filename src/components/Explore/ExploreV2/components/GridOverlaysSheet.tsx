import EbirdCheckbox from "components/Explore/EbirdCheckbox";
import { BottomSheet, Checkbox, Heading4 } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";
import type { ExploreGridOverlays } from "stores/createLayoutSlice";
import useStore from "stores/useStore";

interface Props {
  onPressClose: ( ) => void;
  showGridOverlays: boolean;
}

// Options that only affect the Observations view
const GridOverlaysSheet = ( { onPressClose, showGridOverlays }: Props ) => {
  const { t } = useTranslation( );
  const overlays = useStore( state => state.layout.exploreGridOverlays );
  const setOverlay = useStore( state => state.layout.setExploreGridOverlay );
  const options: { key: keyof ExploreGridOverlays; label: string }[] = [
    { key: "commonName", label: t( "Common-name" ) },
    { key: "scientificName", label: t( "Scientific-name" ) },
    { key: "location", label: t( "Location" ) },
    { key: "dateTime", label: t( "Date-and-time" ) },
    { key: "faveButton", label: t( "Fave-star" ) },
    { key: "faveCount", label: t( "Number-of-favorites" ) },
  ];

  return (
    <BottomSheet headerText={t( "VIEW-OPTIONS" )} onPressClose={onPressClose}>
      <View className="p-7 pt-2 gap-y-4">
        <EbirdCheckbox />
        {showGridOverlays && <Heading4>{t( "GRID-OVERLAYS" )}</Heading4>}
        {showGridOverlays && options.map( ( { key, label } ) => (
          <Checkbox
            key={key}
            accessibilityLabel={label}
            isChecked={overlays[key]}
            onPress={( ) => setOverlay( key, !overlays[key] )}
            text={label}
          />
        ) )}
      </View>
    </BottomSheet>
  );
};

export default GridOverlaysSheet;
