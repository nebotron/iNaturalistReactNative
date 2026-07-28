import { useNavigation, useRoute } from "@react-navigation/native";
import {
  INatIconButton,
} from "components/SharedComponents";
import React from "react";
import {
  useTranslation,
} from "sharedHooks";

const TaxonSearchButton = ( ) => {
  const { t } = useTranslation( );
  const navigation = useNavigation( );
  const { params } = useRoute( );
  // Suggestions can be rendered with no route params at all, and this button
  // lives in the header, so destructuring them unguarded crashed the whole app
  // (via ErrorBoundary) instead of just failing to navigate. Both values are
  // optional downstream — useNavigateWithTaxonSelected already guards the same
  // way — so an empty object is a safe fallback.
  const { entryScreen, lastScreen } = params || {};

  return (
    <INatIconButton
      icon="magnifying-glass"
      onPress={
        ( ) => navigation.navigate(
          "SuggestionsTaxonSearch",
          {
            entryScreen,
            lastScreen: lastScreen === "ObsDetails"
              ? "ObsDetails"
              : "ObsEdit",
          },
        )
      }
      accessibilityLabel={t( "Search" )}
    />
  );
};

export default TaxonSearchButton;
