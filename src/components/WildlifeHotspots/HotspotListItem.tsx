import {
  Body2,
  Body3,
  Body4,
  Button,
  INatIcon,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React from "react";
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
}

const HotspotListItem = ( {
  hotspot,
  rank,
  selected,
  onPress,
  onOpenInGoogleMaps,
  onAddToRoute,
  onSpeciesCountPress,
}: Props ) => {
  const detourText = hotspot.detourMinutes < 1
    ? "On route"
    : `+${hotspot.detourMinutes} min detour`;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Hotspot ${rank}, ${hotspot.observationCount} observations`}
    >
      <View
        className={`mx-3 mb-3 rounded-xl p-4 ${
          selected
            ? "bg-white border-2 border-inatGreen"
            : "bg-white border border-lightGray"
        }`}
      >
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
              {hotspot.observationCount.toLocaleString()}
              {" observations"}
            </Body2>
          </View>
          <View className="flex-row items-center">
            <INatIcon name="location" size={12} color={colors.darkGray} />
            <Body3 className="ml-1 text-darkGray">{detourText}</Body3>
          </View>
        </View>

        {hotspot.topSpecies.length > 0 && (
          <View className="mt-3">
            {hotspot.topSpecies.map( species => (
              <View
                key={String( species.id )}
                className="flex-row items-center mb-1"
              >
                <INatIcon name="leaf" size={10} color={colors.inatGreen} />
                <Body3
                  className="ml-2 flex-1 text-darkGray"
                  numberOfLines={1}
                >
                  {species.preferred_common_name || species.name}
                  {"  ·  "}
                  <Body3
                    className="text-inatGreen underline"
                    onPress={() => onSpeciesCountPress?.( species )}
                    accessibilityRole="button"
                    accessibilityLabel={`View ${species.count} observations of ${species.preferred_common_name || species.name} in Explore`}
                  >
                    {species.count}
                  </Body3>
                  {species.meanTimeOfDay ? `  ·  ${species.meanTimeOfDay}` : ""}
                </Body3>
              </View>
            ) )}
          </View>
        )}
        {selected && ( onAddToRoute || onOpenInGoogleMaps ) && (
          <View className="flex-row mt-3 space-x-2">
            {onAddToRoute && (
              <Button
                className="flex-1"
                text="Add to Route"
                level="focus"
                onPress={onAddToRoute}
                testID="HotspotListItem.addToRoute"
              />
            )}
            {onOpenInGoogleMaps && (
              <Button
                className="flex-1"
                text="Open Map"
                level="neutral"
                onPress={onOpenInGoogleMaps}
                testID="HotspotListItem.openInGoogleMaps"
              />
            )}
          </View>
        )}
      </View>
    </Pressable>
  );
};

export default HotspotListItem;
