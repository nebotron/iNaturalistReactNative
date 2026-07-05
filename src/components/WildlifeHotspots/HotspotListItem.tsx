import {
  Body2,
  Body3,
  Button,
  Heading4,
  INatIcon,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React from "react";
import colors from "styles/tailwindColors";

import type { Hotspot } from "./hooks/useRouteHotspots";

interface Props {
  hotspot: Hotspot;
  rank: number;
  selected: boolean;
  onPress: () => void;
  onOpenInGoogleMaps?: () => void;
}

const HotspotListItem = ( {
  hotspot,
  rank,
  selected,
  onPress,
  onOpenInGoogleMaps,
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
        <View className="flex-row items-start">
          <View className="w-9 h-9 rounded-full bg-inatGreen items-center justify-center mr-3 mt-0.5">
            <Heading4 className="text-white">{rank}</Heading4>
          </View>
          <View className="flex-1">
            <Body2 className="font-bold">
              {hotspot.observationCount.toLocaleString()}
              {" observations"}
            </Body2>
            <View className="flex-row items-center mt-1">
              <INatIcon name="location" size={12} color={colors.darkGray} />
              <Body3 className="ml-1 text-darkGray">{detourText}</Body3>
            </View>
          </View>
        </View>

        {hotspot.topSpecies.length > 0 && (
          <View className="mt-3 ml-12">
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
                  {species.preferred_common_name
                    ? `${species.preferred_common_name} (${species.name})`
                    : species.name}
                  <Body3 className="text-darkGray">
                    {`  ·  ${species.count}`}
                  </Body3>
                </Body3>
              </View>
            ) )}
          </View>
        )}
        {selected && onOpenInGoogleMaps && (
          <Button
            className="mt-3"
            text="Open in Google Maps"
            level="focus"
            onPress={onOpenInGoogleMaps}
            testID="HotspotListItem.openInGoogleMaps"
          />
        )}
      </View>
    </Pressable>
  );
};

export default HotspotListItem;
