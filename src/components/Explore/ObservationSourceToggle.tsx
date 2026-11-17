import { isEbirdEnabled } from "api/ebird";
import classNames from "classnames";
import { Body3 } from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";
import type { ObservationSource } from "stores/createLayoutSlice";
import useStore from "stores/useStore";

interface Props {
  className?: string;
}

// Chooses whether Explore's views and Hotspots show iNaturalist, eBird, or both
const ObservationSourceToggle = ( { className }: Props ) => {
  const { t } = useTranslation( );
  const source = useStore( state => state.layout.observationSource );
  const setSource = useStore( state => state.layout.setObservationSource );
  if ( !isEbirdEnabled( ) ) return null;
  const options: { value: ObservationSource; label: string }[] = [
    { value: "inaturalist", label: t( "Observation-source-iNaturalist" ) },
    { value: "ebird", label: t( "Observation-source-eBird" ) },
    { value: "both", label: t( "Observation-source-both" ) },
  ];
  return (
    <View
      accessibilityLabel={t( "Show-observations-from" )}
      accessibilityRole="radiogroup"
      className={classNames( "flex-row rounded-full border border-lightGray", className )}
      testID="ObservationSourceToggle"
    >
      {options.map( ( { value, label } ) => {
        const selected = source === value;
        return (
          <Pressable
            key={value}
            accessibilityLabel={label}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            className={classNames( "px-3 py-1 rounded-full", { "bg-darkGray": selected } )}
            onPress={( ) => setSource( value )}
            testID={`ObservationSourceToggle.${value}`}
          >
            <Body3 className={classNames( { "text-white": selected } )}>{label}</Body3>
          </Pressable>
        );
      } )}
    </View>
  );
};

export default ObservationSourceToggle;
