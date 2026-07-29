import { useNavigation } from "@react-navigation/native";
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
  PRIVACY_ZONE_CANDIDATE_FILTER,
} from "sharedHelpers/privacyZone";
import { useCurrentUser, useTranslation } from "sharedHooks";
import { PRIVACY_ZONE_RADIUS_OPTIONS_METERS } from "stores/createPrivacyZoneSlice";
import { UPLOAD_IN_PROGRESS } from "stores/createUploadObservationsSlice";
import useStore from "stores/useStore";

const { useQuery, useRealm } = RealmContext;

const PrivacyZone = ( ) => {
  const { t } = useTranslation( );
  const realm = useRealm( );
  const navigation = useNavigation( );
  const currentUser = useCurrentUser( );

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

  const hasCenter = privacyZone.latitude != null && privacyZone.longitude != null;

  // Only the current user's observations can have their geoprivacy changed,
  // and locally-created ones have no user until they're saved.
  const candidates = useQuery(
    {
      type: Observation,
      query: obsList => (
        currentUser
          ? obsList.filtered(
            `${PRIVACY_ZONE_CANDIDATE_FILTER} AND ( user == nil OR user.id == $0 )`,
            currentUser.id,
          )
          : obsList.filtered( PRIVACY_ZONE_CANDIDATE_FILTER )
      ),
    },
    [currentUser?.id],
  ) as unknown as RealmObservation[];

  const pastObservationsInZone = useMemo(
    ( ) => (
      isPrivacyZoneActive( privacyZone )
        ? candidates.filter(
          obs => isInPrivacyZone( obs.latitude, obs.longitude, privacyZone ),
        )
        : []
    ),
    [candidates, privacyZone],
  );

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

  const handleApplyToPast = useCallback( ( ) => {
    const count = pastObservationsInZone.length;
    Alert.alert(
      t( "Obscure-Past-Observations" ),
      t( "This-will-obscure-X-observations-and-upload-the-change", { count } ),
      [
        { text: t( "CANCEL" ), style: "cancel" },
        {
          text: t( "OBSCURE" ),
          onPress: ( ) => {
            setApplyingToPast( true );
            const obscured = obscureObservationsInPrivacyZone(
              realm,
              pastObservationsInZone,
            );
            // Reuses the normal upload pipeline, which knows to send already
            // uploaded observations as an update rather than re-uploading
            // their photos.
            obscured.forEach( obs => addTotalToolbarIncrements( obs ) );
            if ( obscured.length > 0 ) {
              addToUploadQueue( obscured.map( obs => obs.uuid ) );
              if ( uploadStatus !== UPLOAD_IN_PROGRESS ) {
                setStartUploadObservations( );
              }
            }
            setApplyingToPast( false );
            Alert.alert(
              t( "Observations-Obscured" ),
              t( "X-observations-were-obscured", { count: obscured.length } ),
            );
          },
        },
      ],
    );
  }, [
    addToUploadQueue,
    addTotalToolbarIncrements,
    pastObservationsInZone,
    realm,
    setStartUploadObservations,
    t,
    uploadStatus,
  ] );

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
          className="mb-8"
          text={t( "Obscure-X-Past-Observations", {
            count: pastObservationsInZone.length,
          } )}
          onPress={handleApplyToPast}
          loading={applyingToPast}
          disabled={applyingToPast || pastObservationsInZone.length === 0}
          level="focus"
          testID="PrivacyZone.ApplyToPastButton"
        />
      </ScrollView>
    </ScreenShell>
  );
};

export default PrivacyZone;
