// @flow

import { useNavigation } from "@react-navigation/native";
import { ViewWrapper } from "components/SharedComponents";
import { View } from "components/styledComponents";
import type { Node } from "react";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Animated } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";
import shouldFetchObservationLocation from "sharedHelpers/shouldFetchObservationLocation";
import {
  useCurrentUser,
  useLocationPermission,
} from "sharedHooks";
import useObservationLocation from "sharedHooks/useObservationLocation";
import useStore from "stores/useStore";
import { getShadow } from "styles/global";

import BottomButtonsContainer from "./BottomButtonsContainer";
import EvidenceSectionContainer from "./EvidenceSectionContainer";
import useMultiObsCreateFlowAutomation from "./hooks/useMultiObsCreateFlowAutomation";
import useMultiObsSaveAndAdvance from "./hooks/useMultiObsSaveAndAdvance";
import IdentificationSection from "./IdentificationSection";
import MultipleObservationsArrows from "./MultipleObservationsArrows";
import MultipleObservationsUploadStatus from "./MultipleObservationsUploadStatus";
import ObsEditHeader from "./ObsEditHeader";
import OtherDataSection from "./OtherDataSection";

const DROP_SHADOW = getShadow( {
  offsetHeight: -2,
} );

const ObsEdit = ( ): Node => {
  const navigation = useNavigation( );
  const currentObservation = useStore( state => state.currentObservation );
  const currentObservationIndex = useStore( state => state.currentObservationIndex );
  const observations = useStore( state => state.observations );
  const setCurrentObservationIndex = useStore( state => state.setCurrentObservationIndex );
  const updateObservationKeys = useStore( state => state.updateObservationKeys );
  const resetUploadObservationsSlice = useStore( state => state.resetUploadObservationsSlice );
  const savedOrUploadedMultiObsFlow = useStore( state => state.savedOrUploadedMultiObsFlow );
  const [passesEvidenceTest, setPassesEvidenceTest] = useState( false );
  const [resetScreen, setResetScreen] = useState( false );
  const [needLocation, setNeedLocation] = useState(
    shouldFetchObservationLocation( currentObservation ),
  );
  const currentUser = useCurrentUser( );
  const {
    hasPermissions: hasLocationPermission,
    renderPermissionsGate: renderLocationPermissionGate,
    requestPermissions: requestLocationPermission,
  } = useLocationPermission( );

  const fadeAnim = useRef( new Animated.Value( 1 ) ).current;
  const hadObservationRef = useRef( !!currentObservation );

  const fade = useCallback( ( ) => {
    fadeAnim.stopAnimation( );
    fadeAnim.setValue( 0 );
    Animated.timing( fadeAnim, {
      toValue: 1,
      duration: 250,
      useNativeDriver: true,
    } ).start( );
  }, [fadeAnim] );

  useEffect( ( ) => {
    // If currentObservation was briefly null (e.g. index out of bounds after
    // upload), the form unmounts while opacity is 0 and stays invisible on remount.
    if ( !hadObservationRef.current && currentObservation ) {
      fadeAnim.stopAnimation( );
      fadeAnim.setValue( 1 );
    }
    hadObservationRef.current = !!currentObservation;
  }, [currentObservation, fadeAnim] );

  useEffect( ( ) => {
    const unsubscribe = navigation.addListener( "focus", ( ) => {
      // If a multi-observation transition was interrupted by pushing another
      // screen, opacity can stay at 0; refocusing must show the form again.
      fadeAnim.setValue( 1 );
    } );
    return unsubscribe;
  }, [navigation, fadeAnim] );

  const animatedStyle = {
    flex: 1,
    opacity: fadeAnim, // Bind opacity to animated value
    ...DROP_SHADOW,
  };

  const shouldFetchLocation = hasLocationPermission && needLocation;

  const {
    isFetchingLocation,
    stopWatch,
    subscriptionId,
    userLocation,
  } = useObservationLocation( { shouldFetchLocation } );

  useEffect( ( ) => {
    if ( userLocation?.latitude ) {
      updateObservationKeys( userLocation );
    }
  }, [userLocation, updateObservationKeys] );

  useEffect( ( ) => {
    resetUploadObservationsSlice( );
  }, [resetUploadObservationsSlice] );

  const navToLocationPicker = useCallback( ( ) => {
    stopWatch( subscriptionId );
    setNeedLocation( false );
    navigation.navigate( "LocationPicker" );
  }, [stopWatch, subscriptionId, navigation] );

  const latitude = currentObservation?.latitude;
  const longitude = currentObservation?.longitude;
  const hasLocation = !!( latitude && longitude );

  const {
    loading: multiObsLoading,
    saveAndAdvance,
  } = useMultiObsSaveAndAdvance( {
    currentObservation,
    currentObservationIndex,
    observations,
    transitionAnimation: fade,
  } );

  useMultiObsCreateFlowAutomation( {
    currentObservation,
    isFetchingLocation,
  } );

  const onLocationPress = ( ) => {
    if ( !hasLocation && !hasLocationPermission ) {
      requestLocationPermission( );
    } else {
      navToLocationPicker( );
    }
  };

  // This should never, ever happen
  if ( currentObservation?.user && currentUser && currentUser.id !== currentObservation.user.id ) {
    throw new Error( "User tried to edit observation they do not own" );
  }

  return (
    <>
      <ViewWrapper testID="obs-edit">
        <KeyboardAwareScrollView
          stickyHeaderIndices={[0]}
        >
          <ObsEditHeader
            currentObservation={currentObservation}
            observations={observations}
          />
          {currentObservation && (
            <View
              className="bg-white rounded-t-3xl mt-1 mb-5"
              style={( observations.length > 1 )
                ? DROP_SHADOW
                : undefined}
            >
              {observations.length > 1 && (
                <MultipleObservationsArrows
                  currentObservationIndex={currentObservationIndex}
                  observations={observations}
                  setCurrentObservationIndex={setCurrentObservationIndex}
                  setResetScreen={setResetScreen}
                  transitionAnimation={fade}
                  transitionAnimationRef={fadeAnim}
                />
              )}
              <Animated.View style={animatedStyle}>
                <EvidenceSectionContainer
                  currentObservation={currentObservation}
                  isFetchingLocation={isFetchingLocation}
                  onLocationPress={onLocationPress}
                  passesEvidenceTest={passesEvidenceTest}
                  setPassesEvidenceTest={setPassesEvidenceTest}
                  updateObservationKeys={updateObservationKeys}
                />
                <IdentificationSection
                  currentObservation={currentObservation}
                  hasLocation={hasLocation}
                  onLocationPress={onLocationPress}
                  resetScreen={resetScreen}
                  setResetScreen={setResetScreen}
                  updateObservationKeys={updateObservationKeys}
                />
                <OtherDataSection
                  currentObservation={currentObservation}
                  updateObservationKeys={updateObservationKeys}
                />
              </Animated.View>
            </View>
          )}
        </KeyboardAwareScrollView>
      </ViewWrapper>
      {savedOrUploadedMultiObsFlow && <MultipleObservationsUploadStatus />}
      {currentObservation && (
        <BottomButtonsContainer
          currentObservation={currentObservation}
          loading={multiObsLoading}
          passesEvidenceTest={passesEvidenceTest}
          saveAndAdvance={saveAndAdvance}
        />
      )}
      {renderLocationPermissionGate( {
        // If the user grants location permission while on this screen,
        // we want to start watching the location no matter how the observation
        // was created (camera, sound recorder, etc.)
        onPermissionGranted: ( ) => setNeedLocation( true ),
        // If the user does not give location permissions in any form,
        // navigate to the location picker (if granted we just continue fetching the location)
        onModalHide: ( ) => {
          if ( !hasLocationPermission ) navToLocationPicker();
        },
      } )}
    </>
  );
};

export default ObsEdit;
