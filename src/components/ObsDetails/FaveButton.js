// @flow
import {
  faveObservation,
} from "api/observations";
import classNames from "classnames";
import {
  ActivityIndicator,
  INatIconButton,
} from "components/SharedComponents";
import { RealmContext } from "providers/contexts";
import type { Node } from "react";
import React, { useCallback, useMemo, useState } from "react";
import { Alert } from "react-native";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import {
  useAuthenticatedMutation,
  useTranslation,
} from "sharedHooks";
import colors from "styles/tailwindColors";

const { useRealm } = RealmContext;

const OBS_IMAGE_ACTION_ICON_SIZE = 50;

type Props = {
  observation: Object,
  currentUser?: Object,
  afterToggleFave?: Function,
  stacked?: boolean,
}

const FaveButton = ( {
  observation,
  currentUser,
  afterToggleFave = ( ) => undefined,
  stacked = false,
}: Props ): Node => {
  const { t } = useTranslation( );
  const realm = useRealm( );
  const uuid = observation?.uuid;
  const [loading, setLoading] = useState( false );

  const isUnuploaded = useMemo( ( ) => {
    return observation && typeof observation.wasSynced === "function"
      ? !observation.wasSynced( )
      : false;
  }, [observation] );

  const observationFaved = useMemo( ( ) => {
    if ( !observation ) return null;
    const faves = observation.votes?.filter( vote => vote?.vote_scope === null ) || [];

    if ( isUnuploaded ) {
      return faves.length > 0;
    }

    if ( currentUser && faves.length > 0 ) {
      const viewerFaved = faves.find( fave => fave.user_id === currentUser.id );
      return !!viewerFaved;
    }
    return null;
  }, [
    currentUser,
    observation,
    isUnuploaded,
  ] );

  const [isFaved, setIsFaved] = useState( observationFaved || false );

  const showErrorAlert = error => {
    let msg = error?.json?.errors.map( err => err.message ).join( "; " );
    if ( error.status === 401 ) {
      msg = t( "You-need-log-in-to-do-that" );
    }
    Alert.alert(
      t( "Error-title" ),
      msg,
      [{ text: t( "OK" ) }],
      { cancelable: true },
    );
  };

  const { mutate: createFaveMutate } = useAuthenticatedMutation(
    ( faveOrUnfaveParams, optsWithAuth ) => faveObservation( faveOrUnfaveParams, optsWithAuth ),
    {
      onSuccess: ( ) => {
        afterToggleFave( true );
        setLoading( false );
      },
      onError: error => {
        showErrorAlert( error );
        setIsFaved( false );
        setLoading( false );
      },
    },
  );

  const toggleLocalFave = useCallback( ( ) => {
    if ( !realm.isClosed && observation && observation.isValid( ) ) {
      safeRealmWrite( realm, ( ) => {
        if ( isFaved ) {
          observation.votes = observation.votes?.filter( v => v?.vote_scope !== null ) || [];
        } else {
          const newVote = {
            id: Math.random( ),
            user_id: currentUser?.id || 0,
            vote_flag: true,
            vote_scope: null,
          };
          observation.votes = [...( observation.votes || [] ), newVote];
        }
      }, "toggling favorite locally for unuploaded observation" );
    }
  }, [realm, observation, isFaved, currentUser] );

  const toggleFave = useCallback( ( ) => {
    if ( isUnuploaded ) {
      setLoading( true );
      toggleLocalFave( );
      setIsFaved( true );
      setLoading( false );
      afterToggleFave( true );
      return;
    }
    if ( !currentUser ) return;
    if ( !isFaved ) {
      setLoading( true );
      setIsFaved( true );
      createFaveMutate( { uuid } );
    }
  }, [
    currentUser,
    createFaveMutate,
    isFaved,
    uuid,
    isUnuploaded,
    toggleLocalFave,
    afterToggleFave,
  ] );

  if ( !observation ) {
    return null;
  }

  if ( !isUnuploaded && !currentUser ) {
    return null;
  }

  const positionClassName = stacked
    ? undefined
    : "absolute top-3 right-3";

  const iconSize = stacked
    ? OBS_IMAGE_ACTION_ICON_SIZE
    : 25;
  const buttonWidth = stacked
    ? OBS_IMAGE_ACTION_ICON_SIZE
    : undefined;
  const buttonHeight = stacked
    ? OBS_IMAGE_ACTION_ICON_SIZE
    : undefined;

  if ( loading ) {
    return (
      <ActivityIndicator
        className={classNames( positionClassName )}
        size={iconSize}
      />
    );
  }

  if ( isFaved ) {
    return null;
  }

  return (
    <INatIconButton
      icon="star-bold-outline"
      size={iconSize}
      width={buttonWidth}
      height={buttonHeight}
      onPress={toggleFave}
      color={colors.white}
      className={classNames( positionClassName )}
      accessibilityLabel={t( "Add-favorite" )}
    />
  );
};

export default FaveButton;
