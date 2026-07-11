import Button from "components/SharedComponents/Buttons/Button";
import EmptySearchResults from "components/Explore/SearchScreens/EmptySearchResults";
import SearchBar from "components/SharedComponents/SearchBar";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import { View } from "components/styledComponents";
import { useStackHost } from "navigation/StackHostContext";
import React, { useMemo } from "react";
import { FlatList } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RealmTaxon } from "realmModels/types";
import { useKeyboardInfo, useTranslation } from "sharedHooks";
import { getShadow } from "styles/global";

const DROP_SHADOW = getShadow( {
  offsetHeight: 4,
} );

const EMPTY_TAXA: RealmTaxon[] = [];

interface Props {
  query?: string;
  setQuery: ( newQuery: string ) => void;
  isLoading?: boolean;
  isUpdatingLocalDb?: boolean;
  updateLocalSpeciesDb?: ( ) => void;
  renderItem: (
    { item, index }: { item: RealmTaxon; index: number }
  ) => React.ReactElement<unknown>;
  taxa: RealmTaxon[];
}

const TaxonSearch = ( {
  isLoading = false,
  isUpdatingLocalDb = false,
  query = "",
  renderItem,
  setQuery,
  taxa = EMPTY_TAXA,
  updateLocalSpeciesDb,
}: Props ) => {
  const { hasBottomTabBar } = useStackHost( );
  const { bottom } = useSafeAreaInsets( );
  const paddingBottom = !hasBottomTabBar
    ? bottom
    : 0;
  const { t } = useTranslation( );
  const { keyboardHeight, keyboardShown } = useKeyboardInfo( );

  const emptyListComponent = useMemo( ( ) => (
    query.length > 0
      ? (
        <EmptySearchResults
          isLoading={isLoading}
          searchQuery="does it matter?"
          skipOfflineNotice
        />
      )
      : null
  ), [query.length, isLoading] );

  // Make sure all of the results can be scrolled to even with the keyboard
  // up
  const footerComponent = ( ) => (
    <>
      {query.length > 0 && updateLocalSpeciesDb && (
        <Button
          className="mx-6 mt-3"
          onPress={updateLocalSpeciesDb}
          loading={isUpdatingLocalDb}
          disabled={isUpdatingLocalDb}
          text={t( "UPDATE-LOCAL-SPECIES-DATABASE" )}
          testID="TaxonSearch.updateLocalSpeciesDb"
        />
      )}
      {keyboardShown
        ? <View style={{ paddingBottom: paddingBottom + keyboardHeight }} />
        : <View style={{ paddingBottom }} />}
    </>
  );

  return (
    <ScreenShell>
      <View
        className="bg-white px-6 pt-2 pb-[21px]"
        style={DROP_SHADOW}
      >
        <SearchBar
          handleTextChange={setQuery}
          value={query}
          testID="SearchTaxon"
          autoFocus={query === ""}
        />
      </View>
      <FlatList
        keyboardShouldPersistTaps="always"
        data={taxa}
        renderItem={renderItem}
        keyExtractor={taxon => String( taxon.id )}
        ListEmptyComponent={emptyListComponent}
        ListFooterComponent={footerComponent}
      />
    </ScreenShell>
  );
};

export default TaxonSearch;
