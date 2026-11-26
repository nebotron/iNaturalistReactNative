import {
  useIsFocused,
  useNavigation,
  useNavigationState,
  useRoute,
} from "@react-navigation/native";
import type { NoBottomTabStackScreenProps } from "navigation/types";
import { useEffect } from "react";
import type { RealmObservation } from "realmModels/types";
import hasValidCoordinates from "sharedHelpers/hasValidCoordinates";

interface Options {
  currentObservation: RealmObservation | null;
  isFetchingLocation: boolean;
}

const useMultiObsCreateFlowAutomation = ( {
  currentObservation,
  isFetchingLocation,
}: Options ) => {
  const navigation = useNavigation( );
  const isFocused = useIsFocused( );
  const { params } = useRoute<NoBottomTabStackScreenProps<"ObsEdit">["route"]>( );
  // A shared sound (e.g. a Voice Memo) arrives as an observation with no
  // photos; it should open on the new observation, not jump to taxon search.
  const fromShare = params?.lastScreen === "PhotoSharing";
  const isNewObs = !currentObservation?._created_at;

  const isOnSuggestions = useNavigationState( state => {
    const route = state.routes[state.index];
    return route?.name === "Suggestions" || route?.name === "SuggestionsTaxonSearch";
  } );

  const identTaxon = currentObservation?.taxon;
  const hasIdentification = !!( identTaxon && identTaxon.rank_level !== 100 );
  const hasPhotos = ( currentObservation?.observationPhotos?.length ?? 0 ) > 0;
  const hasLocation = hasValidCoordinates( {
    latitude: currentObservation?.latitude,
    longitude: currentObservation?.longitude,
  } );

  useEffect( ( ) => {
    if ( !isNewObs || !isFocused || isOnSuggestions ) {
      return;
    }
    if ( isFetchingLocation || !hasLocation || hasIdentification ) {
      return;
    }

    if ( hasPhotos ) {
      navigation.push( "Suggestions", {
        entryScreen: "ObsEdit",
        lastScreen: "ObsEdit",
        hideSkip: false,
      } );
    } else if ( !fromShare ) {
      navigation.navigate( "SuggestionsTaxonSearch", {
        entryScreen: "ObsEdit",
        lastScreen: "ObsEdit",
      } );
    }
  }, [
    fromShare,
    hasIdentification,
    hasLocation,
    hasPhotos,
    isFetchingLocation,
    isFocused,
    isNewObs,
    isOnSuggestions,
    navigation,
  ] );
};

export default useMultiObsCreateFlowAutomation;
