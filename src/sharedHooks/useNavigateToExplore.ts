import { useNavigation } from "@react-navigation/native";
import type { ApiProjectSummary, ApiTaxon, ApiUser } from "api/types";
import { OBSERVATIONS_TAB } from "appConstants/tabs";
import { resultToSubject }
  from "components/Explore/helpers/universalSearchSubject";
import type { TabStackScreenProps } from "navigation/types";
import type {
  ExploreFilters,
  ExploreLocationState,
  ExploreSubject,
  ExploreTab,
  Place,
} from "providers/ExploreContext";
import { EXPLORE_PLACE_MODE } from "providers/ExploreContext";
import { useCallback } from "react";
import type { OBSERVATIONS_SORT } from "sharedHelpers/observationsSort";
import useStoredLayout, { EXPLORE_LAYOUT_STORAGE_KEY } from "sharedHooks/useStoredLayout";

interface NavigateToExploreOptions {
  taxon?: ApiTaxon | null;
  user?: ApiUser | null;
  project?: ApiProjectSummary | null;
  place?: Partial<Place> | null;
  tab?: ExploreTab;
  layout?: "map" | "grid" | "list";
  // ExploreV2 only
  filters?: Partial<ExploreFilters>;
  sortBy?: OBSERVATIONS_SORT;
}

const placeLocation = ( place?: Partial<Place> | null ): ExploreLocationState => {
  if ( !place?.id ) { return { placeMode: EXPLORE_PLACE_MODE.WORLDWIDE }; }
  return {
    placeMode: EXPLORE_PLACE_MODE.PLACE,
    place: {
      id: place.id,
      display_name: place.display_name,
    },
  };
};

const toSubject = ( {
  taxon,
  user,
  project,
}: NavigateToExploreOptions ): ExploreSubject | null => {
  if ( taxon?.id ) { return resultToSubject( { type: "taxon", taxon } ); }
  if ( user?.id ) { return resultToSubject( { type: "user", user } ); }
  if ( project?.id ) { return resultToSubject( { type: "project", project } ); }
  return null;
};

// Single place that knows how to open Explore from outside of it
const useNavigateToExplore = ( ) => {
  const navigation = useNavigation<TabStackScreenProps<
    "TaxonDetails" | "UserProfile" | "ProjectDetails" | "ProjectRequirements"
  >["navigation"]>( );
  const { writeLayoutToStorage: writeLayout } = useStoredLayout(
    EXPLORE_LAYOUT_STORAGE_KEY,
  );

  return useCallback( ( {
    taxon,
    user,
    project,
    place,
    tab = OBSERVATIONS_TAB,
    layout,
    filters,
    sortBy,
  }: NavigateToExploreOptions ) => {
    if ( layout ) {
      writeLayout( layout );
    }

    const subject = toSubject( { taxon, user, project } );

    navigation.navigate( "Explore", {
      ...( subject
        ? { subject }
        : {} ),
      location: placeLocation( place ),
      activeTab: tab,
      filters,
      sortBy,
    } );
  }, [navigation, writeLayout] );
};

export default useNavigateToExplore;
