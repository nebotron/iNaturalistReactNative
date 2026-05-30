// @flow
import {
  markAsReviewed,
  markAsUnreviewed,
} from "api/observations";
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
import {
  useAuthenticatedMutation,
  useTranslation,
} from "sharedHooks";
import colors from "styles/tailwindColors";

const OBS_IMAGE_ACTION_ICON_SIZE = 50;

type Props = {
  observation: Object,
  currentUser?: Object,
  afterToggleReview: Function,
  top?: boolean,
  positionClassName?: string,
  stacked?: boolean,
}

const ReviewButton = ( {
  observation,
  currentUser,
  afterToggleReview = ( ) => undefined,
  top = false,
  positionClassName,
  stacked = false,
}: Props ): Node => {
  let iconPositionClassName = positionClassName;
  if ( iconPositionClassName === undefined ) {
    if ( stacked ) {
      iconPositionClassName = undefined;
    } else if ( top ) {
      iconPositionClassName = "absolute top-0";
    } else {
      iconPositionClassName = "absolute bottom-3 left-3";
    }
  }
  const { t } = useTranslation( );
  const observationUuid = observation?.uuid;

  const observationReviewed = useMemo( ( ) => {
    if ( !observation || !currentUser ) return null;
    const reviewedBy = observation.reviewed_by || [];
    return reviewedBy.includes( currentUser.id );
  }, [currentUser, observation] );

  const [isReviewed, setIsReviewed] = useState( observationReviewed || false );
  const [loading, setLoading] = useState( false );

  useEffect( ( ) => {
    setIsReviewed( observationReviewed || false );
  }, [observationReviewed] );

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

  const { mutate: markReviewedMutate } = useAuthenticatedMutation(
    ( params, optsWithAuth ) => markAsReviewed( params, optsWithAuth ),
    {
      onSuccess: ( ) => {
        setIsReviewed( true );
        afterToggleReview( true );
        setLoading( false );
      },
      onError: error => {
        showErrorAlert( error );
        setIsReviewed( false );
        setLoading( false );
      },
    },
  );

  const { mutate: markUnreviewedMutate } = useAuthenticatedMutation(
    ( params, optsWithAuth ) => markAsUnreviewed( params, optsWithAuth ),
    {
      onSuccess: ( ) => {
        setIsReviewed( false );
        afterToggleReview( false );
        setLoading( false );
      },
      onError: error => {
        showErrorAlert( error );
        setIsReviewed( true );
        setLoading( false );
      },
    },
  );

  const toggleReview = useCallback( ( ) => {
    if ( !currentUser || !observationUuid ) return;
    setLoading( true );
    if ( isReviewed ) {
      setIsReviewed( false );
      markUnreviewedMutate( { uuid: observationUuid } );
    } else {
      setIsReviewed( true );
      markReviewedMutate( { uuid: observationUuid } );
    }
  }, [
    currentUser,
    isReviewed,
    markReviewedMutate,
    markUnreviewedMutate,
    observationUuid,
  ] );

  if ( !observation || !observationUuid || !currentUser ) {
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
      icon={isReviewed
        ? "checkmark-circle"
        : "checkmark-circle-outline"}
      size={OBS_IMAGE_ACTION_ICON_SIZE}
      width={OBS_IMAGE_ACTION_ICON_SIZE}
      height={OBS_IMAGE_ACTION_ICON_SIZE}
      onPress={toggleReview}
      color={isReviewed
        ? colors.inatGreen
        : colors.white}
      className={classNames( iconPositionClassName )}
      accessibilityLabel={isReviewed
        ? t( "Unmark-as-reviewed" )
        : t( "Mark-as-reviewed" )}
    />
  );
};

export default ReviewButton;
