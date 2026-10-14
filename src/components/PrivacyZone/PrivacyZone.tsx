import { useNetInfo } from "@react-native-community/netinfo";
import { useNavigation } from "@react-navigation/native";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import {
  Body2,
  Button,
  Heading4,
  List2,
  RadioButtonRow,
  SwitchRow,
} from "components/SharedComponents";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import { ScrollView, View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useCallback, useMemo, useState } from "react";
import { Alert } from "react-native";
import Observation from "realmModels/Observation";
import type { RealmObservation } from "realmModels/types";
import fetchAccurateUserLocation from "sharedHelpers/fetchAccurateUserLocation";
import {
  isInPrivacyZone,
  isPrivacyZoneActive,
  obscureObservationsInPrivacyZone,
  PRIVACY_ZONE_LOCAL_CANDIDATE_FILTER,
} from "sharedHelpers/privacyZone";
import obscureUploadedObservationsInPrivacyZone, {
  countUploadedObservationsInPrivacyZone,
} from "sharedHelpers/privacyZonePastObservations";
import { useAuthenticatedQuery, useCurrentUser, useTranslation } from "sharedHooks";
import { PRIVACY_ZONE_RADIUS_OPTIONS_METERS } from "stores/createPrivacyZoneSlice";
import { UPLOAD_IN_PROGRESS } from "stores/createUploadObservationsSlice";
import useStore from "stores/useStore";

const { useQuery, useRealm } = RealmContext;

const PrivacyZone = ( ) => {
  const { t } = useTranslation( );
  const realm = useRealm( );
  const navigation = useNavigation( );
  const currentUser = useCurrentUser( );
  const { isConnected } = useNetInfo( );

  const privacyZone = useStore( state => state.privacyZone );
  const {
    clearPrivacyZoneCenter,
    setPrivacyZoneCenter,
    setPrivacyZoneEnabled,
    setPrivacyZoneRadiusMeters,
  } = privacyZone;

  const addTotalToolbarIncrements = useStore( state => state.addTotalToolbarIncrements );
  const addToUploadQueue = useStore( state => state.addToUploadQueue );
  const setStartUploadObservations = useStore( state => state.setStartUploadObservations );
  const uploadStatus = useStore( state => state.uploadStatus );

  const [fetchingLocation, setFetchingLocation] = useState( false );
  const [applyingToPast, setApplyingToPast] = useState( false );
  const [applyProgress, setApplyProgress] = useState<{
    done: number;
    total: number;
  } | null>( null );

  const hasCenter = privacyZone.latitude != null && privacyZone.longitude != null;

  // Observations that only exist on this device. Anything already uploaded is
  // counted through the API below, because Realm doesn't store coordinates for
  // observations it learned about from a list response.
  const localCandidates = useQuery(
    {
      type: Observation,
      query: obsList => obsList.filtered( PRIVACY_ZONE_LOCAL_CANDIDATE_FILTER ),
    },
    [],
  ) as unknown as RealmObservation[];

  const zoneActive = isPrivacyZoneActive( privacyZone );

  const localObservationsInZone = useMemo(
    ( ) => (
      zoneActive
        ? localCandidates.filter(
          obs => isInPrivacyZone( obs.latitude, obs.longitude, privacyZone ),
        )
        : []
    ),
    [localCandidates, privacyZone, zoneActive],
  );

  const {
    data: uploadedCount,
    isLoading: countLoading,
    refetch: refetchUploadedCount,
  } = useAuthenticatedQuery<number>(
    [
      "countUploadedObservationsInPrivacyZone",
      currentUser?.id,
      privacyZone.latitude,
      privacyZone.longitude,
      privacyZone.radiusMeters,
    ],
    optsWithAuth => countUploadedObservationsInPrivacyZone(
      currentUser?.id as number,
      privacyZone,
      optsWithAuth,
    ),
    {
      enabled: !!( zoneActive && currentUser?.id && isConnected ),
      requireLoggedIn: true,
    },
  );

  const totalInZone = localObservationsInZone.length + ( uploadedCount ?? 0 );

  const handleUseCurrentLocation = useCallback( async ( ) => {
    setFetchingLocation( true );
    const location = await fetchAccurateUserLocation( );
    setFetchingLocation( false );
    if ( !location ) {
      Alert.alert(
        t( "Location-Permission-Required" ),
        t( "Enable-location-access-to-set-a-privacy-zone" ),
      );
      return;
    }
    setPrivacyZoneCenter( {
      latitude: location.latitude,
      longitude: location.longitude,
    } );
  }, [setPrivacyZoneCenter, t] );

  const applyToPast = useCallback( async ( ) => {
    setApplyingToPast( true );
    try {
      // Observations that have never been uploaded just get obscured locally
      // and handed to the normal upload pipeline.
      const obscuredLocally = obscureObservationsInPrivacyZone(
        realm,
        localObservationsInZone,
      );
      obscuredLocally.forEach( obs => addTotalToolbarIncrements( obs ) );
      if ( obscuredLocally.length > 0 ) {
        addToUploadQueue( obscuredLocally.map( obs => obs.uuid ) );
        if ( uploadStatus !== UPLOAD_IN_PROGRESS ) {
          setStartUploadObservations( );
        }
      }

      // Anything already on iNaturalist is updated in place, which avoids
      // re-uploading media the server already has.
      let remote = { obscured: 0, failed: 0 };
      if ( currentUser?.id && isConnected ) {
        const apiToken = await getJWT( );
        remote = await obscureUploadedObservationsInPrivacyZone(
          realm,
          currentUser.id,
          privacyZone,
          { api_token: apiToken },
          ( done, total ) => setApplyProgress( { done, total } ),
        );
        await refetchUploadedCount( );
      }

      const obscuredCount = obscuredLocally.length + remote.obscured;
      Alert.alert(
        t( "Observations-Obscured" ),
        remote.failed > 0
          ? `${t( "X-observations-were-obscured", { count: obscuredCount } )}\n\n${
            t( "X-observations-could-not-be-obscured", { count: remote.failed } )}`
          : t( "X-observations-were-obscured", { count: obscuredCount } ),
      );
    } catch ( error ) {
      Alert.alert(
        t( "Something-went-wrong" ),
        ( error as Error )?.message,
      );
    } finally {
      setApplyProgress( null );
      setApplyingToPast( false );
    }
  }, [
    addToUploadQueue,
    addTotalToolbarIncrements,
    currentUser,
    isConnected,
    localObservationsInZone,
    privacyZone,
    realm,
    refetchUploadedCount,
    setStartUploadObservations,
    t,
    uploadStatus,
  ] );

  const handleApplyToPast = useCallback( ( ) => {
    Alert.alert(
      t( "Obscure-Past-Observations" ),
      t( "This-will-obscure-X-observations-and-upload-the-change", { count: totalInZone } ),
      [
        { text: t( "CANCEL" ), style: "cancel" },
        { text: t( "OBSCURE" ), onPress: ( ) => { applyToPast( ); } },
      ],
    );
  }, [applyToPast, t, totalInZone] );

  const radiusLabel = useCallback( ( meters: number ) => (
    meters >= 1000
      ? t( "X-km", { km: meters / 1000 } )
      : t( "X-m", { m: meters } )
  ), [t] );

  return (
    <ScreenShell>
      <ScrollView className="p-4">
        <Body2 className="text-darkGray mb-4">
          {t( "Observations-you-save-inside-this-area-will-be-obscured" )}
        </Body2>
        <SwitchRow
          classNames="mb-4"
          label={t( "Obscure-observations-near-a-place" )}
          onValueChange={setPrivacyZoneEnabled}
          disabled={!hasCenter}
          testID="PrivacyZone.EnabledSwitch"
          value={!!privacyZone.enabled}
        />
        <Heading4 className="mb-2">{t( "CENTER" )}</Heading4>
        <List2 className="mb-3">
          {hasCenter
            ? t( "Latitude-Longitude", {
              latitude: ( privacyZone.latitude as number ).toFixed( 5 ),
              longitude: ( privacyZone.longitude as number ).toFixed( 5 ),
            } )
            : t( "No-privacy-zone-set-yet" )}
        </List2>
        <Button
          className="mb-3"
          text={t( "Use-My-Current-Location" )}
          onPress={handleUseCurrentLocation}
          loading={fetchingLocation}
          disabled={fetchingLocation}
          testID="PrivacyZone.CurrentLocationButton"
        />
        <Button
          className="mb-3"
          text={t( "Choose-on-Map" )}
          onPress={( ) => navigation.navigate( "PrivacyZoneMap" )}
          testID="PrivacyZone.ChooseOnMapButton"
        />
        {hasCenter && (
          <Button
            className="mb-4"
            text={t( "Clear-Privacy-Zone" )}
            onPress={clearPrivacyZoneCenter}
            testID="PrivacyZone.ClearButton"
          />
        )}
        <Heading4 className="mb-2">{t( "RADIUS" )}</Heading4>
        <View className="mb-4">
          {PRIVACY_ZONE_RADIUS_OPTIONS_METERS.map( meters => (
            <RadioButtonRow
              key={meters}
              classNames="ml-[6px] mb-[15px]"
              smallLabel
              checked={privacyZone.radiusMeters === meters}
              onPress={( ) => setPrivacyZoneRadiusMeters( meters )}
              label={radiusLabel( meters )}
              value={String( meters )}
            />
          ) )}
        </View>
        <Heading4 className="mb-2">{t( "PAST-OBSERVATIONS" )}</Heading4>
        <Body2 className="text-darkGray mb-3">
          {t( "Obscuring-past-observations-uploads-the-change-to-iNaturalist" )}
        </Body2>
        <Button
          className="mb-3"
          text={t( "Obscure-X-Past-Observations", { count: totalInZone } )}
          onPress={handleApplyToPast}
          loading={applyingToPast || countLoading}
          disabled={applyingToPast || countLoading || totalInZone === 0}
          level="focus"
          testID="PrivacyZone.ApplyToPastButton"
        />
        <View className="mb-8">
          {applyProgress && (
            <List2>
              {t( "Obscuring-X-of-Y-observations", {
                done: applyProgress.done,
                total: applyProgress.total,
              } )}
            </List2>
          )}
        </View>
      </ScrollView>
    </ScreenShell>
  );
};

export default PrivacyZone;
