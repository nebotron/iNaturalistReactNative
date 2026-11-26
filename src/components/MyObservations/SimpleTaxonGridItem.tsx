import classNames from "classnames";
import { Body4, DisplayTaxonName, IconicTaxonIcon } from "components/SharedComponents";
import INatIconButton from "components/SharedComponents/Buttons/INatIconButton";
import CachedImage from "components/SharedComponents/CachedImage";
import {
  LinearGradient, Pressable, View,
} from "components/styledComponents";
import React from "react";
import type { ViewStyle } from "react-native";
import { PixelRatio } from "react-native";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";
import type { SpeciesCount } from "types/sorting";

const imageClassNames = [
  "max-h-[210px]",
  "overflow-hidden",
  "relative",
  "w-[62px]",
  "h-[62px]",
  "rounded-2xl",
];

interface Props {
  accessibleName: string;
  canSearchFromSpeciesTab: boolean;
  navToTaxonDetails: ( ) => void;
  searchThisTaxon: ( ) => void;
  source: {
    uri: string;
  };
  style?: ViewStyle;
  speciesCount: SpeciesCount;
}

const SimpleTaxonGridItem = ( {
  accessibleName,
  canSearchFromSpeciesTab,
  navToTaxonDetails,
  searchThisTaxon,
  source,
  style,
  speciesCount,
}: Props ) => {
  const { t } = useTranslation();
  const { count } = speciesCount;
  // Decode no more pixels than the tile shows
  const tilePx = typeof style?.width === "number"
    ? Math.ceil( style.width * PixelRatio.get( ) )
    : undefined;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={canSearchFromSpeciesTab
        ? searchThisTaxon
        : navToTaxonDetails}
      accessibilityLabel={accessibleName}
      testID="SimpleTaxonGridItem"
      className={classNames( imageClassNames )}
      style={style}
    >
      <View className="absolute w-full h-full">
        <IconicTaxonIcon
          imageClassName={["grow", "aspect-square", "border-0"]}
          iconicTaxonName={speciesCount?.taxon?.iconic_taxon_name}
          isBackground
          size={100}
        />
      </View>
      { source?.uri && (
        // CachedImage rather than <Image>, whose HTTP cache revalidates these
        // URLs (the CDN sends no Cache-Control) and misses offline
        <CachedImage
          source={source}
          className="grow aspect-square"
          testID="TaxonGridItem.photo"
          maxPixelSize={tilePx}
        />
      ) }
      <LinearGradient
        colors={["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0.6) 100%)"]}
        className="absolute w-full h-full"
        start={{ x: 0, y: 0.5 }}
        end={{ x: 0, y: 1 }}
      />
      { canSearchFromSpeciesTab && (
        <View className="absolute top-0 right-0">
          <INatIconButton
            icon="info-circle-outline"
            size={19}
            color={colors.white}
            onPress={navToTaxonDetails}
            accessibilityLabel={accessibleName}
            accessibilityHint={t( "Navigates-to-taxon-details" )}
            testID="SimpleTaxonGridItem.infoButton"
          />
        </View>
      ) }
      <View className="absolute bottom-0 flex p-2 w-full">
        <Body4
          maxFontSizeMultiplier={1.5}
          className="text-white py-1"
        >
          {t( "X-Observations", { count } )}
        </Body4>
        <DisplayTaxonName
          keyBase={`TaxonGridItem-DisplayTaxonName-${speciesCount?.taxon?.id}`}
          taxon={speciesCount?.taxon}
          layout="vertical"
          color="text-white"
          showOneNameOnly
        />
      </View>
    </Pressable>
  );
};

export default SimpleTaxonGridItem;
