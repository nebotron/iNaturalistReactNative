// @flow

import { CommonActions, useNavigation } from "@react-navigation/native";
import AddObsBottomSheet from "components/AddObsBottomSheet/AddObsBottomSheet";
import AddObsTooltip from "components/AddObsBottomSheet/AddObsTooltip";
import GradientButton from "components/SharedComponents/Buttons/GradientButton";
import { groupCropResumeParams } from "components/SharedComponents/ImageCrop/groupCropResume";
import { navigationRef } from "navigation/navigationUtils";
import * as React from "react";
import { log } from "sharedHelpers/logger";
import { useCurrentUser, useLayoutPrefs, useTranslation } from "sharedHooks";
import useStore, { zustandStorage } from "stores/useStore";

const logger = log.extend( "AddObsButton" );

// Last value reported to the metrics log, so remounts don't repeat it.
let lastLoggedAdvancedUserMode = null;

const AddObsButton = ( ): React.Node => {
  const [showBottomSheet, setShowBottomSheet] = React.useState( false );
  const [showTooltip, setShowTooltip] = React.useState( false );
  const [currentRoute, setCurrentRoute] = React.useState( null );

  const { t } = useTranslation();

  const openBottomSheet = React.useCallback( () => setShowBottomSheet( true ), [] );
  const closeBottomSheet = React.useCallback( () => setShowBottomSheet( false ), [] );

  const { isAllAddObsOptionsMode, isPhotoLibraryAddObsMode } = useLayoutPrefs( );
  const currentUser = useCurrentUser( );

  // #region Tooltip logic

  // Controls whether to show the tooltip, and to show it only once to the user
  const showKey = "AddObsButtonTooltip";
  const shownOnce = useStore( state => state.layout.shownOnce );
  const setShownOnce = useStore( state => state.layout.setShownOnce );
  const justFinishedSignup = useStore( state => state.layout.justFinishedSignup );
  const numOfUserObservations = zustandStorage.getItem( "numOfUserObservations" );
  const obsCountLoaded = typeof numOfUserObservations === "number";

  React.useEffect( () => {
    let timeoutId = null;

    // We must know the route name and observation count before evaluating the triggerCondition
    // And, the tooltip should only appear once per app download.
    const shouldEvaluateTrigger = currentRoute?.name && obsCountLoaded && !shownOnce[showKey];

    if ( shouldEvaluateTrigger ) {
      // Base trigger condition in all cases:
      // Only show the tooltip if the user has the AI camera as the default button option.
      // Only show the tooltip on MyObservations screen.
      const isOnMyObservationsResults = currentRoute?.name === "MyObservationsResults";
      const onlyAiCamera = !isAllAddObsOptionsMode && !isPhotoLibraryAddObsMode;

      let triggerCondition = isOnMyObservationsResults && onlyAiCamera;

      if ( justFinishedSignup ) {
        // If a user creates a new account, they should see the tooltip right after dismissing the
        // account creation pivot card and landing on My Obs.
        triggerCondition = triggerCondition && !!shownOnce["account-creation"];
      } else if ( !currentUser ) {
        // If logged out, user should see the tooltip after making their second observation
        triggerCondition = triggerCondition && numOfUserObservations > 1;
      } else if ( numOfUserObservations > 50 ) {
        // If a user logs in to an existing account with >50 observations, they should see the
        // tooltip right after dismissing the "Welcome back!" pivot card and landing on My Obs.
        triggerCondition = triggerCondition && !!shownOnce["fifty-observation"];

        // If a user logs in to an existing account with <=50 observations,
        // they should see the tooltip right after landing on My Obs after signing in
        //
        // If a user is already logged in and updates the app when tooltip is released,
        // they should see the tooltip the first time they open the app after updating
        //
        // Both those cases are covered by not changing the base trigger condition.
      }

      // We use a timeout to avoid opening/closing two modals at the same time, such as the
      // PivotCards that also appear on the MyObs screen.
      if ( triggerCondition ) {
        timeoutId = setTimeout( () => {
          setShowTooltip( true );
        }, 500 );
      }
    }

    return () => {
      if ( timeoutId != null ) {
        clearTimeout( timeoutId );
      }
    };
  }, [
    currentRoute,
    obsCountLoaded,
    numOfUserObservations,
    justFinishedSignup,
    currentUser,
    isAllAddObsOptionsMode,
    isPhotoLibraryAddObsMode,
    shownOnce,
  ] );

  const dismissTooltip = () => {
    setShowTooltip( false );
    setShownOnce( showKey );
    openBottomSheet();
  };

  // #endregion

  // #region Navigation handling

  const resetObservationFlowSlice = useStore( state => state.resetObservationFlowSlice );
  const navigation = useNavigation( );
  React.useEffect( ( ) => {
    // don't remove this logger.info statement: it's used for internal
    // metrics. isAdvancedUser name is vestigial, changing it will make it
    // impossible to compare with older log data.
    // The effect re-runs on every mount of this button — once per return to
    // the tab bar — which repeated the same value 341 times in five days. The
    // metric only means anything when it changes, so only log it then.
    if ( lastLoggedAdvancedUserMode === isAllAddObsOptionsMode ) return;
    lastLoggedAdvancedUserMode = isAllAddObsOptionsMode;
    logger.info( `isAdvancedUser: ${isAllAddObsOptionsMode}` );
  }, [isAllAddObsOptionsMode] );

  type Screen = "ObsEdit" | "Camera" | "PhotoLibrary" | "GroupPhotos" | "SoundRecorder";
  const navAndCloseBottomSheet = ( requestedScreen: Screen, params ) => {
    // An import the user stepped away from is worth returning to rather than
    // silently discarding, so pick it up where they left off
    const importInProgress = useStore.getState( ).groupedPhotos?.length > 0;

    // An import still open in the My Observations tab -- the gallery, Group
    // Photos, or whatever it has pushed on top -- is resumed by switching back
    // to that tab with its stack untouched, so every screen, scroll position
    // and selection is exactly as the user left it
    if ( requestedScreen === "PhotoLibrary" ) {
      const obsTabRoutes = navigationRef.getRootState( )?.routes
        .find( route => route.name === "TabNavigator" )?.state?.routes
        ?.find( route => route.name === "ObservationsTab" )?.state?.routes || [];
      const importerIndex = obsTabRoutes.findIndex(
        route => route.name === "PhotoLibrary" || route.name === "GroupPhotos",
      );
      const onImporter = importerIndex === obsTabRoutes.length - 1;
      if ( importerIndex >= 0 && ( importInProgress || onImporter ) ) {
        navigation.navigate( "TabNavigator", { screen: "ObservationsTab" } );
        closeBottomSheet( );
        return;
      }
    }

    const screen = requestedScreen === "PhotoLibrary" && importInProgress
      ? "GroupPhotos"
      : requestedScreen;

    // Resuming an import must not wipe the photos it's made of
    if ( screen !== "ObsEdit" && screen !== "GroupPhotos" ) {
      resetObservationFlowSlice( );
    }

    // The importer lives in the tab stack so it keeps the bottom tab bar and
    // the user can step away to another tab and come back to it. Navigating
    // (rather than resetting the root) leaves the tab navigator mounted, which
    // is what lets the import survive the trip.
    if ( screen === "PhotoLibrary" || screen === "GroupPhotos" ) {
      // A crop left part way reopens the cropper on the photo it was left on,
      // on top of Group Photos, leaving the other tabs' stacks as they are
      const { groupCropResume, groupedPhotos } = useStore.getState( );
      const crop = screen === "GroupPhotos"
        && groupCropResumeParams( groupCropResume, groupedPhotos );
      if ( crop ) {
        const tabState = navigationRef.getRootState( )?.routes
          .find( route => route.name === "TabNavigator" )?.state;
        const observationsTab = {
          name: "ObservationsTab",
          state: {
            index: 2,
            routes: [
              { name: "ObsList" },
              { name: "GroupPhotos", params: { ...params, previousScreen: currentRoute } },
              { name: "ImageCropEditor", params: crop.params },
            ],
          },
        };
        const tabRoutes = tabState?.routes?.length
          ? tabState.routes.map( route => ( route.name === "ObservationsTab"
            ? observationsTab
            : route ) )
          : [observationsTab];
        navigation.dispatch( CommonActions.reset( {
          index: 0,
          routes: [{
            name: "TabNavigator",
            state: {
              index: tabRoutes.findIndex( route => route.name === "ObservationsTab" ),
              routes: tabRoutes,
            },
          }],
        } ) );
        closeBottomSheet( );
        return;
      }
      navigation.navigate( "TabNavigator", {
        screen: "ObservationsTab",
        params: {
          screen,
          params: { ...params, previousScreen: currentRoute },
        },
      } );
      closeBottomSheet( );
      return;
    }

    // we need to reset the navigation stack whenever a user navigates from the AddObs wheel,
    // otherwise the user can end up closing out to a previous place in the stack, #1857
    navigation.dispatch(
      CommonActions.reset( {
        index: 0,
        routes: [
          {
            name: "NoBottomTabStackNavigator",
            state: {
              index: 0,
              routes: [
                {
                  name: screen,
                  params: { ...params, previousScreen: currentRoute },
                },
              ],
            },
          },
        ],
      } ),
    );

    closeBottomSheet( );
  };
  const navToARCamera = ( ) => { navAndCloseBottomSheet( "Camera", { camera: "AI" } ); };

  // #endregion

  // Keeps currentRoute up-to-date for the use of both navigation & tooltip logic
  React.useEffect( () => {
    if ( navigationRef.isReady() ) {
      const current = navigationRef.getCurrentRoute();
      setCurrentRoute( current );
    }

    const unsubscribe = navigationRef.addListener( "state", () => {
      const current = navigationRef.getCurrentRoute();
      setCurrentRoute( current );
    } );

    return unsubscribe;
  }, [] );

  return (
    <>
      <AddObsTooltip isVisible={showTooltip} dismissTooltip={dismissTooltip} />
      <AddObsBottomSheet
        closeBottomSheet={closeBottomSheet}
        hidden={!showBottomSheet}
        navAndCloseBottomSheet={navAndCloseBottomSheet}
      />
      <GradientButton
        sizeClassName="w-[69px] h-[69px] mb-[5px]"
        onLongPress={() => {
          openBottomSheet();
        }}
        onPress={() => {
          if ( isAllAddObsOptionsMode ) {
            openBottomSheet();
          } else if ( isPhotoLibraryAddObsMode ) {
            navAndCloseBottomSheet( "PhotoLibrary" );
          } else {
            navToARCamera();
          }
        }}
        accessibilityLabel={t( "Add-observations" )}
        accessibilityHint={
          ( isAllAddObsOptionsMode && t( "Shows-observation-creation-options" ) )
          || ( isPhotoLibraryAddObsMode && t( "Navigates-to-photo-importer" ) )
          || t( "Opens-AI-camera" )
        }
        iconName={isAllAddObsOptionsMode && "plus"}
        iconSize={isAllAddObsOptionsMode && 31}
      />
    </>
  );
};

export default AddObsButton;
