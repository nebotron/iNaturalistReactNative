// @flow

import {
  Body1,
  Heading4,
} from "components/SharedComponents";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import { View } from "components/styledComponents";
import type { Node } from "react";
import React, { useCallback, useMemo } from "react";
import { SectionList } from "react-native";
import { useTranslation } from "sharedHooks";

import useObservers from "./hooks/useObservers";
import Suggestion from "./Suggestion";
import SuggestionsEmpty from "./SuggestionsEmpty";
import SuggestionsFooter from "./SuggestionsFooter";
import SuggestionsHeader from "./SuggestionsHeader";

type Props = {
  genusEligibleTaxonIds?: Set<number>,
  handleSkip: Function,
  hideLocationToggleButton: boolean,
  hideSkip?: boolean,
  improveWithLocationButtonOnPress: () => void,
  interactionsDisabled: boolean,
  isLoading: boolean,
  shouldUseEvidenceLocation: boolean,
  onCropPhoto?: Function,
  onPressPhoto: Function,
  onReorderPhotos?: Function,
  onSelectGenus: Function,
  onTaxonChosen: Function,
  photoUris: string[],
  selectedPhotoUri: string,
  showImproveWithLocationButton: boolean,
  showModelToggle: boolean,
  suggestions: Object,
  toggleLocation: Function,
  toggleSuggestionsModel: Function,
  useOfflineModel: boolean
};

const Suggestions = ( {
  genusEligibleTaxonIds,
  handleSkip,
  hideLocationToggleButton,
  hideSkip,
  improveWithLocationButtonOnPress,
  interactionsDisabled,
  isLoading,
  shouldUseEvidenceLocation,
  onCropPhoto,
  onPressPhoto,
  onReorderPhotos,
  onSelectGenus,
  onTaxonChosen,
  photoUris,
  selectedPhotoUri,
  showImproveWithLocationButton,
  showModelToggle,
  suggestions,
  toggleLocation,
  toggleSuggestionsModel,
  useOfflineModel,
}: Props ): Node => {
  const { t } = useTranslation( );
  const {
    otherSuggestions,
    topSuggestion,
  } = suggestions;

  const taxonIds = otherSuggestions?.map( s => s.taxon.id );
  const observers = useObservers( taxonIds );
  const isEmptyList = !topSuggestion && otherSuggestions?.length === 0;
  const showOfflineModelInfo = !isLoading && useOfflineModel && !isEmptyList;

  const handleTaxonChosen = useCallback( ( ...args ) => {
    if ( interactionsDisabled ) { return; }
    onTaxonChosen( ...args );
  }, [interactionsDisabled, onTaxonChosen] );

  const handleSelectGenus = useCallback( suggestion => {
    if ( interactionsDisabled ) { return; }
    onSelectGenus( suggestion );
  }, [interactionsDisabled, onSelectGenus] );

  const renderSuggestion = useCallback( ( { item: suggestion } ) => {
    const showGenusButton = genusEligibleTaxonIds?.has( suggestion.taxon.id );
    return (
      <Suggestion
        accessibilityLabel={t( "Choose-taxon" )}
        suggestion={suggestion}
        onTaxonChosen={handleTaxonChosen}
        onSelectGenus={showGenusButton ? ( ) => handleSelectGenus( suggestion ) : undefined}
      />
    );
  }, [genusEligibleTaxonIds, handleSelectGenus, handleTaxonChosen, t] );

  const renderEmptyList = useMemo( ( ) => (
    <SuggestionsEmpty
      hasTopSuggestion={!!topSuggestion}
      isLoading={isLoading}
      onTaxonChosen={onTaxonChosen}
    />
  ), [isLoading, topSuggestion, onTaxonChosen] );

  const renderFooter = useMemo( ( ) => (
    <SuggestionsFooter
      handleSkip={handleSkip}
      hideLocationToggleButton={hideLocationToggleButton}
      hideSkip={hideSkip}
      shouldUseEvidenceLocation={shouldUseEvidenceLocation}
      observers={observers}
      toggleLocation={toggleLocation}
    />
  ), [
    handleSkip,
    hideLocationToggleButton,
    hideSkip,
    shouldUseEvidenceLocation,
    observers,
    toggleLocation,
  ] );

  const renderHeader = useMemo( ( ) => (
    <SuggestionsHeader
      interactionsDisabled={interactionsDisabled}
      onCropPhoto={onCropPhoto}
      onPressPhoto={onPressPhoto}
      onReorderPhotos={onReorderPhotos}
      photoUris={photoUris}
      selectedPhotoUri={selectedPhotoUri}
      showOfflineModelInfo={showOfflineModelInfo}
      showModelToggle={showModelToggle}
      toggleSuggestionsModel={toggleSuggestionsModel}
      useOfflineModel={useOfflineModel}
      improveWithLocationButtonOnPress={improveWithLocationButtonOnPress}
      showImproveWithLocationButton={showImproveWithLocationButton}
    />
  ), [
    interactionsDisabled,
    onCropPhoto,
    onPressPhoto,
    onReorderPhotos,
    photoUris,
    selectedPhotoUri,
    improveWithLocationButtonOnPress,
    showImproveWithLocationButton,
    showOfflineModelInfo,
    showModelToggle,
    toggleSuggestionsModel,
    useOfflineModel,
  ] );

  const renderSectionHeader = ( { section } ) => {
    if ( section?.data.length === 0 || isLoading ) {
      return null;
    }
    return (
      <Heading4 className="mt-6 mb-4 ml-4 bg-white">{section?.title}</Heading4>
    );
  };

  const renderTopSuggestion = ( { item } ) => {
    if ( isLoading ) { return null; }
    if ( !item ) {
      return (
        <Body1 className="mx-2 p-4 text-center text-xl">
          {t( "We-are-not-confident-enough-to-make-a-top-ID-suggestion" )}
        </Body1>
      );
    }
    const showGenusButton = genusEligibleTaxonIds?.has( item.taxon.id );
    return (
      <View className="bg-inatGreen/[.13]">
        <Suggestion
          accessibilityLabel={t( "Choose-top-taxon" )}
          suggestion={item}
          onTaxonChosen={handleTaxonChosen}
          onSelectGenus={showGenusButton ? ( ) => handleSelectGenus( item ) : undefined}
        />
      </View>
    );
  };

  const createSections = ( ) => {
    if ( isLoading ) {
      return [];
    }
    if ( isEmptyList ) {
      return [];
    }
    return [{
      title: t( "TOP-ID-SUGGESTION" ),
      // If there is a top suggestion we want to show it, but if there isn't
      // we will still show the section with a notice saying there's nothing
      // to show, so data can't be empty
      data: [topSuggestion || null],
      renderItem: renderTopSuggestion,
    }, {
      title: t( "OTHER-SUGGESTIONS" ),
      data: otherSuggestions,
    }];
  };

  const sections = createSections( );

  return (
    <ScreenShell testID="suggestions">
      <SectionList
        ListEmptyComponent={renderEmptyList}
        ListFooterComponent={renderFooter}
        ListHeaderComponent={renderHeader}
        renderItem={renderSuggestion}
        renderSectionHeader={renderSectionHeader}
        sections={sections}
        stickySectionHeadersEnabled={false}
        testID="Suggestions.SectionList"
      />
    </ScreenShell>
  );
};

export default Suggestions;
