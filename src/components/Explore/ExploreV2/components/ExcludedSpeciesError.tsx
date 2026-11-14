import { useNavigation } from "@react-navigation/native";
import { ExcludedSavedSearchError } from "components/Explore/ExploreV2/helpers/excludedSpecies";
import { Body2, Button } from "components/SharedComponents";
import { View } from "components/styledComponents";
import type { ExploreStackScreenProps } from "navigation/types";
import React from "react";
import useTranslation from "sharedHooks/useTranslation";

type T = ReturnType<typeof useTranslation>["t"];

// Literal keys, so the translation scripts can see they're used
const excludedSpeciesErrorMessage = ( error: Error, t: T ): string => {
  if ( !( error instanceof ExcludedSavedSearchError ) ) {
    return t( "Excluded-species-could-not-be-loaded" );
  }
  const name = error.savedSearchName;
  switch ( error.reason ) {
    case "missing":
      return t( "Excluded-saved-search-not-found", { name } );
    case "cycle":
      return t( "Excluded-saved-search-excludes-itself", { name } );
    case "offline":
      return t( "Excluded-saved-search-offline", { name } );
    default: {
      const _exhaustive: never = error.reason;
      return _exhaustive;
    }
  }
};

// Shown instead of results when the species a search leaves out can't be
// resolved, rather than showing results that quietly include them
const ExcludedSpeciesError = ( { error }: { error: Error } ) => {
  const { t } = useTranslation( );
  const navigation
    = useNavigation<ExploreStackScreenProps<"ExploreResults">["navigation"]>( );
  return (
    <View
      className="flex-1 justify-center items-center px-8"
      testID="ExploreResults.excludedSpeciesError"
    >
      <Body2 className="text-center text-warningRed mb-5">
        {excludedSpeciesErrorMessage( error, t )}
      </Body2>
      <Button
        level="neutral"
        text={t( "EDIT-SEARCH" )}
        onPress={( ) => navigation.navigate( "AdvancedSearch" )}
        accessibilityLabel={t( "Edit-search" )}
      />
    </View>
  );
};

export default ExcludedSpeciesError;
