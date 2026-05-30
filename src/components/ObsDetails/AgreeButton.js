// @flow
import { createIdentification, updateIdentification } from "api/identifications";
import classNames from "classnames";
import {
  ActivityIndicator,
  INatIconButton,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import type { Node } from "react";
import React, {
  useCallback, useEffect, useMemo, useState,
} from "react";
import { Alert } from "react-native";
import Taxon from "realmModels/Taxon";
import {
  useAuthenticatedMutation,
  useTranslation,
} from "sharedHooks";
import colors from "styles/tailwindColors";

const OBS_IMAGE_ACTION_ICON_SIZE = 50;

const findRecentUserAgreedToID = ( observation, userId ) => {
  const currentIds = observation?.identifications;
  const userAgree = currentIds?.filter( id => id.user?.id === userId );
  return userAgree?.length > 0 && userAgree[userAgree.length - 1].current
    ? userAgree[userAgree.length - 1]?.taxon?.id
    : undefined;
};

const findUserAgreedIdentification = ( observation, userId, taxonId ) => {
  const matches = observation?.identifications?.filter(
    id => id.user?.id === userId
      && id.taxon?.id === taxonId
      && id.current !== false
      && id.uuid,
  );
  return matches?.length > 0
    ? matches[matches.length - 1]
    : undefined;
};

const isSpeciesOrSubspeciesTaxon = taxon => (
  taxon?.rank_level === Taxon.SPECIES_LEVEL
  || taxon?.rank_level === Taxon.SUBSPECIES_LEVEL
);

type Props = {
  observation: Object,
  currentUser?: Object,
  openAgreeWithIdSheet?: ( taxon: Object ) => void,
  afterAgree?: Function,
  directAgree?: boolean,
  positionClassName?: string,
  stacked?: boolean,
}

const AgreeButton = ( {
  observation,
  currentUser,
  openAgreeWithIdSheet,
  afterAgree = ( ) => undefined,
  directAgree = false,
  positionClassName,
  stacked = false,
}: Props ): Node => {
  const { t } = useTranslation( );
  const taxon = observation?.taxon;

  const userAgreedToId = useMemo(
    ( ) => findRecentUserAgreedToID( observation, currentUser?.id ),
    [currentUser?.id, observation],
  );

  const [isAgreed, setIsAgreed] = useState( userAgreedToId === taxon?.id );
  const [loading, setLoading] = useState( false );

  useEffect( ( ) => {
    setIsAgreed( userAgreedToId === taxon?.id );
  }, [taxon?.id, userAgreedToId] );

  const showAgreeButton = useMemo( ( ) => (
    !!currentUser?.id
    && observation?.user?.id !== currentUser.id
    && taxon?.is_active
    && isSpeciesOrSubspeciesTaxon( taxon )
  ), [currentUser, observation?.user?.id, taxon] );

  let iconPositionClassName = positionClassName;
  if ( iconPositionClassName === undefined ) {
    iconPositionClassName = stacked
      ? undefined
      : "absolute bottom-3 right-3";
  }

  const showErrorAlert = error => {
    let msg = error?.json?.errors?.map( err => err.message ).join( "; " );
    if ( error?.status === 401 ) {
      msg = t( "You-need-log-in-to-do-that" );
    }
    Alert.alert(
      t( "Error-title" ),
      msg,
      [{ text: t( "OK" ) }],
      { cancelable: true },
    );
  };

  const { mutate: createIdentificationMutate } = useAuthenticatedMutation(
    ( idParams, optsWithAuth ) => createIdentification( idParams, optsWithAuth ),
    {
      onSuccess: ( ) => {
        setIsAgreed( true );
        afterAgree( );
        setLoading( false );
      },
      onError: error => {
        showErrorAlert( error );
        setIsAgreed( false );
        setLoading( false );
      },
    },
  );

  const { mutate: updateIdentificationMutate } = useAuthenticatedMutation(
    ( idParams, optsWithAuth ) => updateIdentification( idParams, optsWithAuth ),
    {
      onSuccess: ( ) => {
        setIsAgreed( false );
        afterAgree( );
        setLoading( false );
      },
      onError: error => {
        showErrorAlert( error );
        setIsAgreed( true );
        setLoading( false );
      },
    },
  );

  const handleDirectAgree = useCallback( ( ) => {
    if ( !observation?.uuid || !taxon?.id ) return;
    setIsAgreed( true );
    setLoading( true );
    createIdentificationMutate( {
      identification: {
        observation_id: observation.uuid,
        taxon_id: taxon.id,
      },
    } );
  }, [createIdentificationMutate, observation, taxon] );

  const handleWithdrawAgree = useCallback( ( ) => {
    const agreedIdentification = findUserAgreedIdentification(
      observation,
      currentUser?.id,
      taxon?.id,
    );
    if ( !agreedIdentification?.uuid ) return;
    setIsAgreed( false );
    setLoading( true );
    updateIdentificationMutate( {
      id: agreedIdentification.uuid,
      identification: { current: false },
    } );
  }, [currentUser?.id, observation, taxon?.id, updateIdentificationMutate] );

  const handlePress = useCallback( ( ) => {
    if ( isAgreed ) {
      handleWithdrawAgree( );
      return;
    }
    if ( directAgree || !openAgreeWithIdSheet ) {
      handleDirectAgree( );
    } else if ( taxon ) {
      openAgreeWithIdSheet( taxon );
    }
  }, [
    directAgree,
    handleDirectAgree,
    handleWithdrawAgree,
    isAgreed,
    openAgreeWithIdSheet,
    taxon,
  ] );

  if ( !showAgreeButton || !taxon ) {
    return null;
  }

  if ( loading ) {
    return (
      <View
        className={classNames(
          "items-center justify-center shrink-0",
          iconPositionClassName,
        )}
        style={{
          height: OBS_IMAGE_ACTION_ICON_SIZE,
          width: OBS_IMAGE_ACTION_ICON_SIZE,
        }}
      >
        <ActivityIndicator size={OBS_IMAGE_ACTION_ICON_SIZE} />
      </View>
    );
  }

  return (
    <INatIconButton
      icon="id-agree"
      size={OBS_IMAGE_ACTION_ICON_SIZE}
      width={OBS_IMAGE_ACTION_ICON_SIZE}
      height={OBS_IMAGE_ACTION_ICON_SIZE}
      onPress={handlePress}
      color={isAgreed
        ? colors.inatGreen
        : colors.white}
      className={classNames( iconPositionClassName )}
      accessibilityLabel={isAgreed
        ? t( "Withdraw" )
        : t( "Agree" )}
      testID={`AgreeButton.${taxon.id}`}
    />
  );
};

export default AgreeButton;
