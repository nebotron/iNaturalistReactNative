import type { ExploreTaxonFilter } from "components/Explore/helpers/taxonFilters";
import {
  Body3,
  Button,
  DisplayTaxon,
  Heading4,
  INatIcon,
  INatIconButton,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";

interface Props {
  iconicTaxonNames?: string[];
  onOpenTaxonSearch: () => void;
  taxonFilters: ExploreTaxonFilter[];
  updateTaxonFilters: ( taxonFilters: ExploreTaxonFilter[] ) => void;
}

const ExploreTaxonFiltersSection = ( {
  iconicTaxonNames = [],
  onOpenTaxonSearch,
  taxonFilters,
  updateTaxonFilters,
}: Props ) => {
  const { t } = useTranslation( );
  const hasUnknownIconicTaxon = iconicTaxonNames.indexOf( "unknown" ) >= 0;
  const hasTaxonFilters = taxonFilters.length > 0 || hasUnknownIconicTaxon;

  const removeFilter = ( taxonId: number ) => {
    updateTaxonFilters(
      taxonFilters.filter( filter => filter.taxon.id !== taxonId ),
    );
  };

  const clearTaxonFilters = () => {
    updateTaxonFilters( [] );
  };

  return (
    <View className="mb-7">
      <Heading4 className="px-4 mb-5">{t( "TAXON" )}</Heading4>
      <View className="px-4 mb-5">
        {hasTaxonFilters
          ? (
            <View>
              {hasUnknownIconicTaxon && (
                <View className="flex-row justify-between items-center mb-5">
                  <DisplayTaxon taxon="unknown" />
                  <INatIconButton
                    icon="close"
                    size={20}
                    onPress={clearTaxonFilters}
                    accessibilityLabel={t( "Remove-taxon-filter" )}
                  />
                </View>
              )}
              {taxonFilters.map( filter => (
                <Pressable
                  key={`taxon-filter-${filter.taxon.id}-${filter.exclude}`}
                  className="flex-row justify-between items-center mb-5"
                  accessibilityRole="button"
                  accessibilityLabel={t( "Change-taxon" )}
                  onPress={onOpenTaxonSearch}
                >
                  <View className="flex-1 mr-3">
                    <DisplayTaxon
                      handlePress={onOpenTaxonSearch}
                      taxon={filter.taxon}
                      showInfoButton={false}
                      showCheckmark={false}
                    />
                    <Body3 className="mt-1">
                      {filter.exclude
                        ? t( "Exclude-taxon" )
                        : t( "Include-taxon" )}
                    </Body3>
                  </View>
                  <View className="flex-row items-center">
                    <INatIcon name="edit" size={22} />
                    <INatIconButton
                      className="ml-3"
                      icon="close"
                      size={20}
                      onPress={() => removeFilter( filter.taxon.id )}
                      accessibilityLabel={t( "Remove-taxon-filter" )}
                    />
                  </View>
                </Pressable>
              ) )}
              <Button
                text={t( "ADD-TAXON-FILTER" )}
                onPress={onOpenTaxonSearch}
                accessibilityLabel={t( "Search" )}
              />
            </View>
          )
          : (
            <Button
              text={t( "SEARCH-FOR-A-TAXON" )}
              onPress={onOpenTaxonSearch}
              accessibilityLabel={t( "Search" )}
            />
          )}
      </View>
    </View>
  );
};

export default ExploreTaxonFiltersSection;
