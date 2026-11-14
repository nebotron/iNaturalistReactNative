import classnames from "classnames";
import locationLabel from "components/Explore/ExploreV2/helpers/locationLabel";
import relativeSavedSearch from "components/Explore/ExploreV2/helpers/relativeSavedSearch";
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
import type { ExploreV2SearchWithTab } from "providers/ExploreV2Context";
import React from "react";
import { Alert } from "react-native";
import useTranslation from "sharedHooks/useTranslation";
import type { SavedSearch } from "stores/createExploreV2SearchesSlice";
import { findSavedSearchByName } from "stores/createExploreV2SearchesSlice";
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
  currentSearch: ExploreV2SearchWithTab;
  onCloseDelete: ( ) => void;
  onCloseSave: ( ) => void;
  onCloseRename: ( ) => void;
  searchToDelete: SavedSearch | null;
  searchToRename: SavedSearch | null;
  showSaveSheet: boolean;
}

// Rendered outside the screen's ScrollView so the sheets overlay the screen
export const SavedSearchSheets = ( {
  currentSearch,
  onCloseDelete,
  onCloseRename,
  onCloseSave,
  searchToDelete,
  searchToRename,
  showSaveSheet,
}: SheetsProps ) => {
  const { t } = useTranslation( );
  const searches = useStore( state => state.exploreSavedSearches.searches );
  const saveSearch = useStore( state => state.exploreSavedSearches.saveSearch );
  const removeSearch = useStore( state => state.exploreSavedSearches.removeSearch );
  const renameSearch = useStore( state => state.exploreSavedSearches.renameSearch );

  // A usable name, or null after explaining why it isn't. The search being
  // renamed may keep its own name in a different case.
  const validName = ( name: string | undefined, ownKey?: string ): string | null => {
    const trimmedName = name?.trim( );
    if ( !trimmedName ) { return null; }
    const existing = findSavedSearchByName( searches, trimmedName );
    if ( existing && existing.key !== ownKey ) {
      Alert.alert(
        t( "Saved-filter-already-exists-title" ),
        t( "Saved-filter-already-exists-description" ),
      );
      return null;
    }
    return trimmedName;
  };

  const saveCurrentSearch = ( name: string | undefined ) => {
    const trimmedName = validName( name );
    if ( !trimmedName ) { return false; }
    saveSearch( { ...currentSearch, key: `saved-${Date.now( )}`, name: trimmedName } );
    return true;
  };

  // Searches that exclude this one's species keep the old name, and show an error until
  // they're pointed at it again
  const renameSavedSearch = ( name: string | undefined ) => {
    if ( !searchToRename ) { return false; }
    const trimmedName = validName( name, searchToRename.key );
    if ( !trimmedName ) { return false; }
    renameSearch( searchToRename.key, trimmedName );
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
      {searchToRename && (
        <TextInputSheet
          buttonText={t( "SAVE" )}
          confirm={renameSavedSearch}
          headerText={t( "Rename-saved-filter" )}
          initialInput={searchToRename.name ?? ""}
          multiline={false}
          onPressClose={onCloseRename}
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
  currentSearch: ExploreV2SearchWithTab;
  onDelete: ( search: SavedSearch ) => void;
  onRename: ( search: SavedSearch ) => void;
  onSave: ( ) => void;
  onSelect: ( search: SavedSearch ) => void;
}

const SavedSearches = ( {
  currentSearch, onDelete, onRename, onSave, onSelect,
}: Props ) => {
  const { t } = useTranslation( );
  const searches = useStore( state => state.exploreSavedSearches.searches );
  const updateSearch = useStore( state => state.exploreSavedSearches.updateSearch );
  const currentKey = savedSearchKey( currentSearch );

  return (
    <View className="mb-5 px-4" testID="SavedSearches">
      <Heading4 className="mb-3">{t( "SAVED-SEARCHES" )}</Heading4>
      <Button
        className="mb-2"
        level="neutral"
        text={t( "Save-current-filters" )}
        onPress={onSave}
        accessibilityLabel={t( "Save-current-filters" )}
        testID="SavedSearches.save"
      />
      {searches.length === 0
        ? <Body3 className="text-darkGray">{t( "No-saved-filters-yet" )}</Body3>
        : searches.map( search => {
          const isActive = savedSearchKey( relativeSavedSearch( search ) ) === currentKey;
          return (
            <View key={search.key} className="flex-row items-center">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t( "Load-saved-filter" )}
                accessibilityState={{ selected: isActive }}
                className={classnames(
                  "flex-1 py-1 px-3 rounded-lg border-[2px]",
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
                icon="label-outline"
                onPress={( ) => onRename( search )}
                size={20}
                accessibilityLabel={t( "Rename-saved-filter" )}
                testID={`SavedSearches.rename.${search.key}`}
              />
              <INatIconButton
                icon="pencil-outline"
                onPress={( ) => updateSearch( search.key, currentSearch )}
                size={20}
                accessibilityLabel={t( "Overwrite-saved-filter" )}
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
