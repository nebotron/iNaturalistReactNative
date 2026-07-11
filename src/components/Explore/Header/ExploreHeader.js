// @flow

import classNames from "classnames";
import ExploreLocationSearchModal from "components/Explore/Modals/ExploreLocationSearchModal";
import ExploreTaxonSearchModal from "components/Explore/Modals/ExploreTaxonSearchModal";
import NumberBadge from "components/Explore/NumberBadge";
import {
  BackButton,
  Body3,
  INatIcon,
  INatIconButton,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import { useExplore } from "providers/ExploreContext";
import type { Node } from "react";
import React, { useState } from "react";
import { Surface } from "react-native-paper";
import { useLayoutPrefs, useTranslation } from "sharedHooks";
import { AUTO_BRIGHTNESS_MODE } from "stores/createLayoutSlice";

import colors from "styles/tailwindColors";

import placeGuessText from "../helpers/placeGuessText";
import ExploreHeaderCount from "./ExploreHeaderCount";

const NEXT_AUTO_BRIGHTNESS_MODE = {
  [AUTO_BRIGHTNESS_MODE.OFF]: AUTO_BRIGHTNESS_MODE.MULTIPLY,
  [AUTO_BRIGHTNESS_MODE.MULTIPLY]: AUTO_BRIGHTNESS_MODE.GAMMA,
  [AUTO_BRIGHTNESS_MODE.GAMMA]: AUTO_BRIGHTNESS_MODE.OFF,
};

const AUTO_BRIGHTNESS_LABEL_KEY = {
  [AUTO_BRIGHTNESS_MODE.OFF]: "Auto-Brightness-Off",
  [AUTO_BRIGHTNESS_MODE.MULTIPLY]: "Auto-Brightness-Multiply",
  [AUTO_BRIGHTNESS_MODE.GAMMA]: "Auto-Brightness-Gamma",
};

type Props = {
  count: ?number,
  exploreView: string,
  exploreViewIcon: string,
  hasLocationPermissions?: boolean,
  hideBackButton: boolean,
  isFetchingHeaderCount: boolean,
  onPressCount?: Function,
  openFiltersModal: Function,
  renderLocationPermissionsGate: Function,
  requestLocationPermissions: Function,
  updateLocation: Function,
  updateTaxonFilters: Function
}

const Header = ( {
  count,
  exploreView,
  exploreViewIcon,
  hasLocationPermissions,
  hideBackButton,
  isFetchingHeaderCount,
  onPressCount,
  openFiltersModal,
  renderLocationPermissionsGate,
  requestLocationPermissions,
  updateLocation,
  updateTaxonFilters,
}: Props ): Node => {
  const { t } = useTranslation( );
  const { autoBrightnessMode, setAutoBrightnessMode } = useLayoutPrefs( );
  const { state, numberOfFilters } = useExplore( );
  const { taxonFilters } = state;
  const iconicTaxonNames = state.iconic_taxa || [];
  const hasUnknownIconicTaxon = iconicTaxonNames.indexOf( "unknown" ) >= 0;
  const taxonFilterCount = ( taxonFilters || [] ).length;
  const showMultipleTaxa = hasUnknownIconicTaxon
    ? taxonFilterCount > 0
    : taxonFilterCount > 1;
  const singleTaxonFilter = taxonFilterCount === 1
    ? taxonFilters[0]
    : null;
  const [showTaxonSearch, setShowTaxonSearch] = useState( false );
  const [showLocationSearch, setShowLocationSearch] = useState( false );

  const placeGuess = placeGuessText( state.placeMode, t, state.place_guess );

  const taxonFilterText = ( ) => {
    if ( showMultipleTaxa ) return t( "Multiple-taxa" );
    if ( hasUnknownIconicTaxon || !singleTaxonFilter ) {
      return singleTaxonFilter
        ? t( "Unknown--taxon" )
        : t( "All-organisms" );
    }
    return singleTaxonFilter.taxon?.preferred_common_name
      || singleTaxonFilter.taxon?.name;
  };

  const surfaceStyle = {
    backgroundColor: colors.darkGray,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
    marginBottom: -32,
  };

  return (
    <View className="z-10">
      <Surface style={surfaceStyle} elevation={5}>
        <View className="bg-white px-4 py-1 flex-row justify-between items-center">
          <View className="flex-1 flex-row">
            {!hideBackButton && (
              <BackButton
                inCustomHeader
                testID="Explore.BackButton"
              />
            ) }
            <View className="flex-1 flex-row justify-between">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t( "Change-taxon-filter" )}
                className="flex-1 flex-row items-center"
                onPress={() => setShowTaxonSearch( true )}
              >
                <INatIcon name="label-outline" size={15} />
                <Body3
                  maxFontSizeMultiplier={1.5}
                  className="ml-2 shrink"
                  numberOfLines={1}
                >
                  {taxonFilterText( )}
                </Body3>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={( ) => setShowLocationSearch( true )}
                className="flex-1 flex-row items-center ml-2"
              >
                <INatIcon name="location" size={15} />
                <Body3
                  maxFontSizeMultiplier={1.5}
                  className="ml-2 shrink"
                  numberOfLines={1}
                >
                  {placeGuess}
                </Body3>
              </Pressable>
            </View>
          </View>
          <View className="flex-row items-center">
            <INatIconButton
              icon={autoBrightnessMode === AUTO_BRIGHTNESS_MODE.OFF
                ? "flash-off"
                : "flash-on"}
              color={colors.white}
              className={classNames(
                autoBrightnessMode !== AUTO_BRIGHTNESS_MODE.OFF
                  ? "bg-inatGreen"
                  : "bg-darkGray",
                "rounded-md mr-2",
              )}
              onPress={() => setAutoBrightnessMode(
                NEXT_AUTO_BRIGHTNESS_MODE[autoBrightnessMode],
              )}
              accessibilityLabel={`${t( "Auto-Adjust-Brightness" )}: `
                + `${t( AUTO_BRIGHTNESS_LABEL_KEY[autoBrightnessMode] )}`}
              testID="Explore.autoBrightnessToggle"
            />
            <View>
              <INatIconButton
                icon="sliders"
                color={colors.white}
                className={classNames(
                  numberOfFilters !== 0
                    ? "bg-inatGreen"
                    : "bg-darkGray",
                  "rounded-md",
                )}
                onPress={() => openFiltersModal()}
                accessibilityLabel={t( "Filters" )}
                accessibilityHint={t( "Navigates-to-explore" )}
              />
              {numberOfFilters !== 0 && (
                <View className="absolute top-[-10] right-[-10]">
                  <NumberBadge number={numberOfFilters} light />
                </View>
              )}
            </View>
          </View>
        </View>
        <ExploreHeaderCount
          count={count}
          exploreView={exploreView}
          exploreViewIcon={exploreViewIcon}
          isFetching={isFetchingHeaderCount}
          onPress={onPressCount}
        />
      </Surface>
      <ExploreTaxonSearchModal
        showModal={showTaxonSearch}
        closeModal={() => { setShowTaxonSearch( false ); }}
        taxonFilters={taxonFilters || []}
        updateTaxonFilters={updateTaxonFilters}
      />
      <ExploreLocationSearchModal
        closeModal={() => { setShowLocationSearch( false ); }}
        hasPermissions={hasLocationPermissions}
        renderPermissionsGate={renderLocationPermissionsGate}
        requestPermissions={requestLocationPermissions}
        showModal={showLocationSearch}
        updateLocation={updateLocation}
      />
    </View>
  );
};

export default Header;
