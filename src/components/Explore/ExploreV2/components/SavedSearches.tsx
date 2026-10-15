import classnames from "classnames";
import locationLabel from "components/Explore/ExploreV2/helpers/locationLabel";
import savedSearchKey from "components/Explore/ExploreV2/helpers/savedSearchKey";
import subjectLabel from "components/Explore/ExploreV2/helpers/subjectLabel";
import {
  Body1,
  Body3,
  Button,
  Heading4,
  INatIconButton,
  TextInputSheet,
  WarningSheet,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import type { ExploreV2Search } from "providers/ExploreV2Context";
import React from "react";
import { Alert } from "react-native";
import useTranslation from "sharedHooks/useTranslation";
import type { SavedSearch } from "stores/createExploreV2SearchesSlice";
import useStore from "stores/useStore";

type T = ReturnType<typeof useTranslation>["t"];

// Searches saved before names existed are labeled by their subject and place
const searchName = ( search: SavedSearch, t: T ) => {
  if ( search.name ) { return search.name; }
  const subjectText = subjectLabel( search.subject, t );
  const place = locationLabel( search.location, t );
  return place
    ? t( "Search-subject-comma-place", { place, subject: subjectText } )
    : subjectText;
};

interface SheetsProps {
  currentSearch: ExploreV2Search;
  onCloseDelete: ( ) => void;
  onCloseSave: ( ) => void;
  searchToDelete: SavedSearch | null;
  showSaveSheet: boolean;
}

// Rendered outside the screen's ScrollView so the sheets overlay the screen
export const SavedSearchSheets = ( {
  currentSearch, onCloseDelete, onCloseSave, searchToDelete, showSaveSheet,
}: SheetsProps ) => {
  const { t } = useTranslation( );
  const searches = useStore( state => state.exploreSavedSearches.searches );
  const saveSearch = useStore( state => state.exploreSavedSearches.saveSearch );
  const removeSearch = useStore( state => state.exploreSavedSearches.removeSearch );

  const saveCurrentSearch = ( name: string ) => {
    const trimmedName = name.trim( );
    if ( !trimmedName ) { return false; }
    const lowerName = trimmedName.toLowerCase( );
    if ( searches.some( search => search.name?.trim( ).toLowerCase( ) === lowerName ) ) {
      Alert.alert(
        t( "Saved-filter-already-exists-title" ),
        t( "Saved-filter-already-exists-description" ),
      );
      return false;
    }
    saveSearch( { ...currentSearch, key: `saved-${Date.now( )}`, name: trimmedName } );
    return true;
  };

  return (
    <>
      {showSaveSheet && (
        <TextInputSheet
          buttonText={t( "SAVE" )}
          confirm={saveCurrentSearch}
          headerText={t( "Save-current-filters" )}
          multiline={false}
          onPressClose={onCloseSave}
          placeholder={t( "Saved-filter-name-placeholder" )}
          maxLength={100}
        />
      )}
      {searchToDelete && (
        <WarningSheet
          buttonText={t( "DELETE" )}
          confirm={( ) => {
            removeSearch( searchToDelete.key );
            onCloseDelete( );
          }}
          handleSecondButtonPress={onCloseDelete}
          headerText={t( "Delete-saved-filter-title" )}
          loading={false}
          onPressClose={onCloseDelete}
          secondButtonText={t( "CANCEL" )}
          text={t( "Delete-saved-filter-description", { name: searchName( searchToDelete, t ) } )}
        />
      )}
    </>
  );
};

interface Props {
  currentSearch: ExploreV2Search;
  onDelete: ( search: SavedSearch ) => void;
  onSave: ( ) => void;
  onSelect: ( search: SavedSearch ) => void;
}

const SavedSearches = ( {
  currentSearch, onDelete, onSave, onSelect,
}: Props ) => {
  const { t } = useTranslation( );
  const searches = useStore( state => state.exploreSavedSearches.searches );
  const updateSearch = useStore( state => state.exploreSavedSearches.updateSearch );
  const currentKey = savedSearchKey( currentSearch );

  return (
    <View className="mb-7 px-4" testID="SavedSearches">
      <Heading4 className="mb-5">{t( "SAVED-SEARCHES" )}</Heading4>
      <Button
        className="mb-5"
        level="neutral"
        text={t( "Save-current-filters" )}
        onPress={onSave}
        accessibilityLabel={t( "Save-current-filters" )}
        testID="SavedSearches.save"
      />
      {searches.length === 0
        ? <Body3 className="text-darkGray">{t( "No-saved-filters-yet" )}</Body3>
        : searches.map( search => {
          const isActive = savedSearchKey( search ) === currentKey;
          return (
            <View key={search.key} className="flex-row items-center mb-4">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t( "Load-saved-filter" )}
                accessibilityState={{ selected: isActive }}
                className={classnames(
                  "flex-1 py-2 px-3 rounded-lg border-[2px]",
                  isActive
                    ? "border-inatGreen bg-inatGreen/10"
                    : "border-transparent",
                )}
                onPress={( ) => onSelect( search )}
                testID={`SavedSearches.load.${search.key}`}
              >
                <Body1>{searchName( search, t )}</Body1>
              </Pressable>
              <INatIconButton
                icon="pencil-outline"
                onPress={( ) => updateSearch( search.key, currentSearch )}
                size={20}
                accessibilityLabel={t( "Overwrite-saved-filter" )}
                className="mr-3"
                testID={`SavedSearches.overwrite.${search.key}`}
              />
              <INatIconButton
                icon="trash-outline"
                onPress={( ) => onDelete( search )}
                size={20}
                accessibilityLabel={t( "Delete-saved-filter" )}
                testID={`SavedSearches.delete.${search.key}`}
              />
            </View>
          );
        } )}
    </View>
  );
};

export default SavedSearches;
