import { BottomSheet, Checkbox, Heading4 } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";
import type { ExploreGridOverlays } from "stores/createLayoutSlice";
import useStore from "stores/useStore";

interface Props {
  onPressClose: ( ) => void;
  showGridOverlays: boolean;
  // Use the Me tab's overlays instead of Explore's
  myObs?: boolean;
}

// Options that only affect the Observations view
const GridOverlaysSheet = ( { onPressClose, showGridOverlays, myObs }: Props ) => {
  const { t } = useTranslation( );
  const overlays = useStore( state => ( myObs
    ? state.layout.myObsGridOverlays
    : state.layout.exploreGridOverlays ) );
  const setOverlay = useStore( state => ( myObs
    ? state.layout.setMyObsGridOverlay
    : state.layout.setExploreGridOverlay ) );
  const options: { key: keyof ExploreGridOverlays; label: string }[] = [
    { key: "commonName", label: t( "Common-name" ) },
    { key: "scientificName", label: t( "Scientific-name" ) },
    { key: "location", label: t( "Location" ) },
    { key: "dateTime", label: t( "Date-and-time" ) },
    { key: "faveButton", label: t( "Fave-star" ) },
    { key: "faveCount", label: t( "Number-of-favorites" ) },
    // Only your own observations carry camera settings
    { key: "camera", label: t( "Camera" ) },
    { key: "lens", label: t( "Lens" ) },
    { key: "focalLength", label: t( "Focal-length" ) },
    { key: "aperture", label: t( "Aperture" ) },
    { key: "shutterSpeed", label: t( "Shutter-speed" ) },
    { key: "iso", label: t( "ISO" ) },
    { key: "focusDistance", label: t( "Focus-distance" ) },
  ];

  return (
    <BottomSheet headerText={t( "VIEW-OPTIONS" )} onPressClose={onPressClose}>
      <View className="p-7 pt-2 gap-y-4">
        {showGridOverlays && <Heading4>{t( "GRID-OVERLAYS" )}</Heading4>}
        {showGridOverlays && options.map( ( { key, label } ) => (
          <Checkbox
            key={key}
            accessibilityLabel={label}
            isChecked={!!overlays[key]}
            onPress={( ) => setOverlay( key, !overlays[key] )}
            text={label}
          />
        ) )}
      </View>
    </BottomSheet>
  );
};

export default GridOverlaysSheet;
