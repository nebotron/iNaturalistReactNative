import {
  Body2,
  Body3,
  Body4,
  INatIcon,
  INatIconButton,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

import type { Hotspot, HotspotSpecies } from "./hooks/useRouteHotspots";

interface Props {
  hotspot: Hotspot;
  rank: number;
  selected: boolean;
  onPress: () => void;
  onOpenInGoogleMaps?: () => void;
  onAddToRoute?: () => void;
  onSpeciesCountPress?: ( species: HotspotSpecies ) => void;
  onObservationCountPress?: () => void;
}

const HotspotListItem = ( {
  hotspot,
  rank,
  selected,
  onPress,
  onOpenInGoogleMaps,
  onAddToRoute,
  onSpeciesCountPress,
  onObservationCountPress,
}: Props ) => {
  const { t } = useTranslation();
  const detourText = hotspot.detourMinutes < 1
    ? "On route"
    : `+${hotspot.detourMinutes} min detour`;

  return (
    <Pressable
      className="flex-1"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Hotspot ${rank}, ${hotspot.observationCount} observations`}
    >
      <View className="flex-1 p-2 bg-white border border-lightGray">
        <View className="flex-row items-center">
          <View
            className="w-6 h-6 rounded-full items-center justify-center mr-2 border border-white"
            style={{
              backgroundColor: selected
                ? colors.inatGreen
                : colors.warningYellow,
            }}
          >
            <Body4 className="text-white font-bold">{rank}</Body4>
          </View>
          <View className="flex-1">
            <Body2 className="font-bold">
              <Body2
                className="font-bold text-inatGreen underline"
                onPress={onObservationCountPress}
                accessibilityRole="button"
                accessibilityLabel={
                  `View ${hotspot.observationCount} observations in Explore`
                }
              >
                {hotspot.observationCount.toLocaleString()}
              </Body2>
              {` observations, ${hotspot.speciesCount.toLocaleString()} species`}
            </Body2>
          </View>
          <View className="flex-row items-center">
            <INatIcon name="location" size={12} color={colors.darkGray} />
            <Body3 className="ml-1 text-darkGray">{detourText}</Body3>
          </View>
          {onAddToRoute && (
            <INatIconButton
              className="w-8 h-8 ml-1"
              icon="plus"
              size={18}
              color={colors.inatGreen}
              onPress={onAddToRoute}
              accessibilityLabel={t( "Add-hotspot-to-route" )}
              testID="HotspotListItem.addToRoute"
            />
          )}
          {onOpenInGoogleMaps && (
            <INatIconButton
              className="w-8 h-8"
              icon="map"
              size={18}
              color={colors.darkGray}
              onPress={onOpenInGoogleMaps}
              accessibilityLabel={t( "Open-route-in-Google-Maps" )}
              testID="HotspotListItem.openInGoogleMaps"
            />
          )}
        </View>

        {hotspot.topSpecies.length > 0 && (
          <View className="mt-1">
            {hotspot.topSpecies.map( species => (
              <View
                key={species.id ?? species.name}
                className="flex-row items-center mb-0.5"
              >
                <INatIcon name="leaf" size={10} color={colors.inatGreen} />
                <Body3
                  className="ml-2 flex-1 text-darkGray"
                  numberOfLines={1}
                >
                  {species.preferred_common_name || species.name}
                  {"  ·  "}
                  {/* eBird-only species have no iNaturalist taxon to open */}
                  {species.id
                    ? (
                      <Body3
                        className="text-inatGreen underline"
                        onPress={() => onSpeciesCountPress?.( species )}
                        accessibilityRole="button"
                        accessibilityLabel={
                          `View ${species.count} observations of `
                          + `${species.preferred_common_name || species.name} in Explore`
                        }
                      >
                        {species.count}
                      </Body3>
                    )
                    : species.count}
                  {species.meanTimeOfDay
                    ? `  ·  ${species.meanTimeOfDay}`
                    : ""}
                </Body3>
              </View>
            ) )}
          </View>
        )}
      </View>
    </Pressable>
  );
};

export default HotspotListItem;
