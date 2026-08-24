import { StackActions, useNavigation, useRoute } from "@react-navigation/native";
import { UPLOAD } from "components/ObsEdit/BottomButtons";
import useMultiObsSaveAndAdvance from "components/ObsEdit/hooks/useMultiObsSaveAndAdvance";
import type { NoBottomTabStackScreenProps, TabStackScreenProps } from "navigation/types";
import { useCallback } from "react";
import useStore from "stores/useStore";

const useNavigateWithTaxonSelected = (
  options: {
    vision: boolean;
  },
) => {
  // This hook is used in SuggestionsTaxonSearch and SuggestionsContainer.
  // Both screens are in the SharedStackNavigator.
  // So the navigation types here are possible from TabStack or NoBottomTabStack
  const navigation = useNavigation<
    NoBottomTabStackScreenProps<"Suggestions" | "SuggestionsTaxonSearch">["navigation"] &
    TabStackScreenProps<"Suggestions" | "SuggestionsTaxonSearch">["navigation"]
  >( );
  const { name: routeName, params } = useRoute<
    NoBottomTabStackScreenProps<"Suggestions" | "SuggestionsTaxonSearch">["route"] &
    TabStackScreenProps<"Suggestions" | "SuggestionsTaxonSearch">["route"]
  >( );
  const { entryScreen, lastScreen } = params || {};
  const currentObservation = useStore( state => state.currentObservation );
  const observations = useStore( state => state.observations );
  const savedOrUploadedMultiObsFlow = useStore( state => state.savedOrUploadedMultiObsFlow );
  const bulkUploadMode = useStore( state => state.bulkUploadMode );
  const updateObservationKeys = useStore( state => state.updateObservationKeys );
  const vision = options?.vision;

  // bulkUploadMode means the user entered the bulk ID flow from My
  // Observations, which is a multi-obs flow even when only one observation
  // needs an ID. That flow can't be recognized by route params, because
  // popping back to Suggestions from TaxonDetails replaces them, so after the
  // first ID made from a taxon's detail screen there'd be no entryScreen or
  // lastScreen left and the next ID would land in ObsEdit -- a screen this
  // stack doesn't even contain, since the flow starts at Suggestions.
  // Suggesting an ID from ObsDetails is never this flow, even if an
  // abandoned bulk flow left the flag set.
  const isBulkIdFlow = bulkUploadMode
    && entryScreen !== "ObsDetails"
    && lastScreen !== "ObsDetails";
  const isMultiObsCreateFlow = isBulkIdFlow || (
    ( observations.length > 1 || savedOrUploadedMultiObsFlow )
    && entryScreen === "ObsEdit" && lastScreen === "ObsEdit"
  );

  const { saveAndAdvance } = useMultiObsSaveAndAdvance( {
    transitionAnimation: ( ) => undefined,
  } );

  const navigateWithTaxonSelected = useCallback( async ( selectedTaxon: object | undefined ) => {
    if ( selectedTaxon === undefined ) {
      updateObservationKeys( {
        owners_identification_from_vision: false,
        taxon: selectedTaxon,
      } );
    } else {
      updateObservationKeys( {
        owners_identification_from_vision: vision,
        taxon: selectedTaxon,
      } );
    }

    if ( selectedTaxon !== undefined && isMultiObsCreateFlow ) {
      const numObservations = useStore.getState( ).observations.length;
      await saveAndAdvance( bulkUploadMode
        ? UPLOAD
        : "save" );
      if ( numObservations > 1 ) {
        if ( routeName === "SuggestionsTaxonSearch" ) {
          // Explicitly navigate back to Suggestions (now showing the next
          // observation in the bulk flow) rather than relying on goBack,
          // which can silently no-op if there's no history to pop to.
          if ( navigation.canGoBack( ) ) {
            navigation.goBack( );
          } else {
            navigation.navigate( "Suggestions", { entryScreen, lastScreen } );
          }
        }
        return;
      }
      return;
    }

    // checking for previous screen here rather than a synced/unsynced observation
    // because a user can arrive on Suggestions/TaxonSearch
    // in two different ways from ObsDetails -> they can land directly on the Suggestions
    // screen (by adding an id) or they can first land on ObsEdit (by tapping the edit button)
    if ( lastScreen === "ObsDetails" ) {
      // popping suggestions off the stack and returning to inital ObsDetails
      navigation.dispatch( {
        ...StackActions.popTo( "ObsDetails", {
          uuid: currentObservation?.uuid,
          identTaxonId: selectedTaxon?.id,
          identTaxonFromVision: vision,
          identAt: Date.now(),
        } ),
      } );
    } else if ( entryScreen === "ObsEdit" ) {
      // Cant' go back b/c we might be on Suggestions OR TaxonSearch. Don't
      // want to set lastScreen b/c we don't want to go back to suggestions
      navigation.navigate( "ObsEdit" );
    } else {
      navigation.navigate( "ObsEdit", { lastScreen: "Suggestions" } );
    }
  }, [
    bulkUploadMode,
    currentObservation?.uuid,
    entryScreen,
    isMultiObsCreateFlow,
    lastScreen,
    navigation,
    routeName,
    saveAndAdvance,
    updateObservationKeys,
    vision,
  ] );

  return navigateWithTaxonSelected;
};

export default useNavigateWithTaxonSelected;
