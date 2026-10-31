import {
  Body1,
  Body3,
  Button,
  Heading4,
  ScrollViewWrapper,
} from "components/SharedComponents";
import { TextInput, View } from "components/styledComponents";
import type { TFunction } from "i18next";
import React, { useState } from "react";
import type { TunableKey, TunableSection } from "sharedHelpers/tunableParams";
import {
  getTunable,
  isTunableOverridden,
  resetAllTunables,
  resetTunable,
  setTunable,
  TUNABLE_PARAMS,
} from "sharedHelpers/tunableParams";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

const sectionTitles = ( t: TFunction ): Record<TunableSection, string> => ( {
  ai: t( "Tunable-section-ai" ),
  audio: t( "Tunable-section-audio" ),
  camera: t( "Tunable-section-camera" ),
  location: t( "Tunable-section-location" ),
  uploads: t( "Tunable-section-uploads" ),
  storage: t( "Tunable-section-storage" ),
  usb: t( "Tunable-section-usb" ),
  explore: t( "Tunable-section-explore" ),
  game: t( "Tunable-section-game" ),
  interface: t( "Tunable-section-interface" ),
} );

const paramText = ( t: TFunction ): Record<TunableKey, [string, string]> => ( {
  aiCameraFps: [
    t( "Tunable-aiCameraFps" ),
    t( "Tunable-aiCameraFps-description" ),
  ],
  aiCameraConfidenceThreshold: [
    t( "Tunable-aiCameraConfidenceThreshold" ),
    t( "Tunable-aiCameraConfidenceThreshold-description" ),
  ],
  aiCameraStoredResults: [
    t( "Tunable-aiCameraStoredResults" ),
    t( "Tunable-aiCameraStoredResults-description" ),
  ],
  aiCameraCropRatio: [
    t( "Tunable-aiCameraCropRatio" ),
    t( "Tunable-aiCameraCropRatio-description" ),
  ],
  topSuggestionScoreThreshold: [
    t( "Tunable-topSuggestionScoreThreshold" ),
    t( "Tunable-topSuggestionScoreThreshold-description" ),
  ],
  matchHighConfidence: [
    t( "Tunable-matchHighConfidence" ),
    t( "Tunable-matchHighConfidence-description" ),
  ],
  matchLikelyConfidence: [
    t( "Tunable-matchLikelyConfidence" ),
    t( "Tunable-matchLikelyConfidence-description" ),
  ],
  onlineSuggestionsTimeoutSeconds: [
    t( "Tunable-onlineSuggestionsTimeoutSeconds" ),
    t( "Tunable-onlineSuggestionsTimeoutSeconds-description" ),
  ],
  subjectCropPadding: [
    t( "Tunable-subjectCropPadding" ),
    t( "Tunable-subjectCropPadding-description" ),
  ],
  subjectCropFrameFraction: [
    t( "Tunable-subjectCropFrameFraction" ),
    t( "Tunable-subjectCropFrameFraction-description" ),
  ],
  audioIdThreshold: [
    t( "Tunable-audioIdThreshold" ),
    t( "Tunable-audioIdThreshold-description" ),
  ],
  audioIdAlsoHeard: [
    t( "Tunable-audioIdAlsoHeard" ),
    t( "Tunable-audioIdAlsoHeard-description" ),
  ],
  audioIdDimAfterSeconds: [
    t( "Tunable-audioIdDimAfterSeconds" ),
    t( "Tunable-audioIdDimAfterSeconds-description" ),
  ],
  audioIdFlashSeconds: [
    t( "Tunable-audioIdFlashSeconds" ),
    t( "Tunable-audioIdFlashSeconds-description" ),
  ],
  audioIdBirdGeoThreshold: [
    t( "Tunable-audioIdBirdGeoThreshold" ),
    t( "Tunable-audioIdBirdGeoThreshold-description" ),
  ],
  audioIdNonBirdGeoThreshold: [
    t( "Tunable-audioIdNonBirdGeoThreshold" ),
    t( "Tunable-audioIdNonBirdGeoThreshold-description" ),
  ],
  maxPhotosPerObservation: [
    t( "Tunable-maxPhotosPerObservation" ),
    t( "Tunable-maxPhotosPerObservation-description" ),
  ],
  maxSoundsPerObservation: [
    t( "Tunable-maxSoundsPerObservation" ),
    t( "Tunable-maxSoundsPerObservation-description" ),
  ],
  maxCameraZoom: [
    t( "Tunable-maxCameraZoom" ),
    t( "Tunable-maxCameraZoom-description" ),
  ],
  minFreeStorageMb: [
    t( "Tunable-minFreeStorageMb" ),
    t( "Tunable-minFreeStorageMb-description" ),
  ],
  maxPhotoInspectZoom: [
    t( "Tunable-maxPhotoInspectZoom" ),
    t( "Tunable-maxPhotoInspectZoom-description" ),
  ],
  targetLocationAccuracyM: [
    t( "Tunable-targetLocationAccuracyM" ),
    t( "Tunable-targetLocationAccuracyM-description" ),
  ],
  locationAccuracyDeadlineSeconds: [
    t( "Tunable-locationAccuracyDeadlineSeconds" ),
    t( "Tunable-locationAccuracyDeadlineSeconds-description" ),
  ],
  desiredLocationAccuracyM: [
    t( "Tunable-desiredLocationAccuracyM" ),
    t( "Tunable-desiredLocationAccuracyM-description" ),
  ],
  locationHistoryDistanceM: [
    t( "Tunable-locationHistoryDistanceM" ),
    t( "Tunable-locationHistoryDistanceM-description" ),
  ],
  locationHistoryIntervalMinutes: [
    t( "Tunable-locationHistoryIntervalMinutes" ),
    t( "Tunable-locationHistoryIntervalMinutes-description" ),
  ],
  locationMatchMaxGapHours: [
    t( "Tunable-locationMatchMaxGapHours" ),
    t( "Tunable-locationMatchMaxGapHours-description" ),
  ],
  locationHistoryMaxAccuracyM: [
    t( "Tunable-locationHistoryMaxAccuracyM" ),
    t( "Tunable-locationHistoryMaxAccuracyM-description" ),
  ],
  defaultObsLocationAccuracyM: [
    t( "Tunable-defaultObsLocationAccuracyM" ),
    t( "Tunable-defaultObsLocationAccuracyM-description" ),
  ],
  maxConcurrentUploads: [
    t( "Tunable-maxConcurrentUploads" ),
    t( "Tunable-maxConcurrentUploads-description" ),
  ],
  uploadMaxDimension: [
    t( "Tunable-uploadMaxDimension" ),
    t( "Tunable-uploadMaxDimension-description" ),
  ],
  uploadMaxMb: [
    t( "Tunable-uploadMaxMb" ),
    t( "Tunable-uploadMaxMb-description" ),
  ],
  uploadMaxRetries: [
    t( "Tunable-uploadMaxRetries" ),
    t( "Tunable-uploadMaxRetries-description" ),
  ],
  uploadTimeoutMinutes: [
    t( "Tunable-uploadTimeoutMinutes" ),
    t( "Tunable-uploadTimeoutMinutes-description" ),
  ],
  importSectionGapMinutes: [
    t( "Tunable-importSectionGapMinutes" ),
    t( "Tunable-importSectionGapMinutes-description" ),
  ],
  importMaxSectionSize: [
    t( "Tunable-importMaxSectionSize" ),
    t( "Tunable-importMaxSectionSize-description" ),
  ],
  cropCacheDays: [
    t( "Tunable-cropCacheDays" ),
    t( "Tunable-cropCacheDays-description" ),
  ],
  remoteImageCacheMb: [
    t( "Tunable-remoteImageCacheMb" ),
    t( "Tunable-remoteImageCacheMb-description" ),
  ],
  cropSourcesCacheMb: [
    t( "Tunable-cropSourcesCacheMb" ),
    t( "Tunable-cropSourcesCacheMb-description" ),
  ],
  syncedPhotoFolderMaxGb: [
    t( "Tunable-syncedPhotoFolderMaxGb" ),
    t( "Tunable-syncedPhotoFolderMaxGb-description" ),
  ],
  maxOfflineObservations: [
    t( "Tunable-maxOfflineObservations" ),
    t( "Tunable-maxOfflineObservations-description" ),
  ],
  offlineMaxTileZoom: [
    t( "Tunable-offlineMaxTileZoom" ),
    t( "Tunable-offlineMaxTileZoom-description" ),
  ],
  offlineMaxMapPins: [
    t( "Tunable-offlineMaxMapPins" ),
    t( "Tunable-offlineMaxMapPins-description" ),
  ],
  usbMaxPhotosPerScan: [
    t( "Tunable-usbMaxPhotosPerScan" ),
    t( "Tunable-usbMaxPhotosPerScan-description" ),
  ],
  ebirdMaxDistKm: [
    t( "Tunable-ebirdMaxDistKm" ),
    t( "Tunable-ebirdMaxDistKm-description" ),
  ],
  ebirdBackDays: [
    t( "Tunable-ebirdBackDays" ),
    t( "Tunable-ebirdBackDays-description" ),
  ],
  ebirdMaxResults: [
    t( "Tunable-ebirdMaxResults" ),
    t( "Tunable-ebirdMaxResults-description" ),
  ],
  ebirdCollapsedCount: [
    t( "Tunable-ebirdCollapsedCount" ),
    t( "Tunable-ebirdCollapsedCount-description" ),
  ],
  hotspotClusterRadiusKm: [
    t( "Tunable-hotspotClusterRadiusKm" ),
    t( "Tunable-hotspotClusterRadiusKm-description" ),
  ],
  hotspotParkingMinutes: [
    t( "Tunable-hotspotParkingMinutes" ),
    t( "Tunable-hotspotParkingMinutes-description" ),
  ],
  hotspotRoutePaddingKm: [
    t( "Tunable-hotspotRoutePaddingKm" ),
    t( "Tunable-hotspotRoutePaddingKm-description" ),
  ],
  hotspotRecentAddresses: [
    t( "Tunable-hotspotRecentAddresses" ),
    t( "Tunable-hotspotRecentAddresses-description" ),
  ],
  hotspotTimeStepMinutes: [
    t( "Tunable-hotspotTimeStepMinutes" ),
    t( "Tunable-hotspotTimeStepMinutes-description" ),
  ],
  hotspotMaxPlanCandidates: [
    t( "Tunable-hotspotMaxPlanCandidates" ),
    t( "Tunable-hotspotMaxPlanCandidates-description" ),
  ],
  placeSearchMaxSuggestions: [
    t( "Tunable-placeSearchMaxSuggestions" ),
    t( "Tunable-placeSearchMaxSuggestions-description" ),
  ],
  gamePoolSize: [
    t( "Tunable-gamePoolSize" ),
    t( "Tunable-gamePoolSize-description" ),
  ],
  gameLookalikeRadiusKm: [
    t( "Tunable-gameLookalikeRadiusKm" ),
    t( "Tunable-gameLookalikeRadiusKm-description" ),
  ],
  gameLocationRadiusKm: [
    t( "Tunable-gameLocationRadiusKm" ),
    t( "Tunable-gameLocationRadiusKm-description" ),
  ],
  toastDurationSeconds: [
    t( "Tunable-toastDurationSeconds" ),
    t( "Tunable-toastDurationSeconds-description" ),
  ],
  minSmallGridColumns: [
    t( "Tunable-minSmallGridColumns" ),
    t( "Tunable-minSmallGridColumns-description" ),
  ],
  advancedModeOnboardingObservations: [
    t( "Tunable-advancedModeOnboardingObservations" ),
    t( "Tunable-advancedModeOnboardingObservations-description" ),
  ],
  autoAdvancedModeObservations: [
    t( "Tunable-autoAdvancedModeObservations" ),
    t( "Tunable-autoAdvancedModeObservations-description" ),
  ],
} );

interface RowProps {
  paramKey: TunableKey;
  label: string;
  description: string;
}

const TunableRow = ( { paramKey, label, description }: RowProps ) => {
  const { t } = useTranslation( );
  const param = TUNABLE_PARAMS[paramKey];
  const [text, setText] = useState( String( getTunable( paramKey ) ) );
  const [overridden, setOverridden] = useState( isTunableOverridden( paramKey ) );

  const commit = ( ) => {
    const value = Number( text );
    if ( text.trim( ) === "" || !Number.isFinite( value ) ) {
      resetTunable( paramKey );
    } else {
      setTunable( paramKey, value );
    }
    setText( String( getTunable( paramKey ) ) );
    setOverridden( isTunableOverridden( paramKey ) );
  };

  return (
    <View className="mt-[20px]">
      <Body1>{label}</Body1>
      <Body3 className="mt-1">{description}</Body3>
      <TextInput
        accessibilityLabel={label}
        className={`border h-10 rounded-xl px-3 mt-2 text-base ${overridden
          ? "border-inatGreen"
          : "border-lightGray"}`}
        keyboardType="numbers-and-punctuation"
        onBlur={commit}
        onChangeText={setText}
        onSubmitEditing={commit}
        placeholder={String( param.default )}
        placeholderTextColor={colors.darkGray}
        returnKeyType="done"
        value={text}
      />
      <Body3 className="mt-1 text-darkGray">
        {t( "Tunable-default-and-range", {
          default: param.default,
          min: param.min,
          max: param.max,
        } )}
      </Body3>
    </View>
  );
};

const TunableParams = ( ) => {
  const { t } = useTranslation( );
  // Remounts every row so they re-read their values after a reset
  const [resetCount, setResetCount] = useState( 0 );
  const titles = sectionTitles( t );
  const text = paramText( t );
  const keys = Object.keys( TUNABLE_PARAMS ) as TunableKey[];

  return (
    <ScrollViewWrapper>
      <View className="p-4 pb-[40px]" key={resetCount}>
        <Body3>{t( "Tunable-parameters-restart-note" )}</Body3>
        <Button
          className="mt-[15px]"
          level="neutral"
          text={t( "RESET-ALL-TO-DEFAULTS" )}
          onPress={( ) => {
            resetAllTunables( );
            setResetCount( count => count + 1 );
          }}
        />
        {( Object.keys( titles ) as TunableSection[] ).map( section => (
          <View key={section} className="mt-[30px]">
            <Heading4>{titles[section]}</Heading4>
            {keys
              .filter( key => TUNABLE_PARAMS[key].section === section )
              .map( key => (
                <TunableRow
                  key={key}
                  paramKey={key}
                  label={text[key][0]}
                  description={text[key][1]}
                />
              ) )}
          </View>
        ) )}
      </View>
    </ScrollViewWrapper>
  );
};

export default TunableParams;
