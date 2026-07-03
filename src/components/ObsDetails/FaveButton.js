// @flow
import {
  faveObservation,
  unfaveObservation,
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
    if ( !observation ) return false;
    // Real Realm observations expose wasSynced( ). Observations mapped for the
    // MyObservations screen are plain objects without that method, so fall back
    // to checking for a server-assigned id, which is only set once uploaded.
    return typeof observation.wasSynced === "function"
      ? !observation.wasSynced( )
      : !observation.id;
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

  const { mutate: deleteFaveMutate } = useAuthenticatedMutation(
    ( faveOrUnfaveParams, optsWithAuth ) => unfaveObservation( faveOrUnfaveParams, optsWithAuth ),
    {
      onSuccess: ( ) => {
        afterToggleFave( false );
        setLoading( false );
      },
      onError: error => {
        showErrorAlert( error );
        setIsFaved( true );
        setLoading( false );
      },
    },
  );

  const toggleLocalFave = useCallback( ( ) => {
    if ( realm.isClosed || !uuid ) return;
    // observation may be a plain object mapped for display (e.g. on the
    // MyObservations screen), so look up the Realm-managed record by uuid
    // rather than writing directly to the prop we were passed.
    const realmObservation = realm.objectForPrimaryKey( "Observation", uuid );
    if ( !realmObservation || !realmObservation.isValid( ) ) return;
    safeRealmWrite( realm, ( ) => {
      if ( isFaved ) {
        realmObservation.votes = realmObservation.votes
          ?.filter( v => v?.vote_scope !== null ) || [];
      } else {
        const newVote = {
          id: Math.floor( Math.random( ) * 1e9 ),
          user_id: currentUser?.id || 0,
          vote_flag: true,
          vote_scope: null,
        };
        realmObservation.votes = [...( realmObservation.votes || [] ), newVote];
      }
    }, "toggling favorite locally for unuploaded observation" );
  }, [realm, uuid, isFaved, currentUser] );

  const toggleFave = useCallback( ( ) => {
    if ( isUnuploaded ) {
      setLoading( true );
      toggleLocalFave( );
      const newIsFaved = !isFaved;
      setIsFaved( newIsFaved );
      setLoading( false );
      afterToggleFave( newIsFaved );
      return;
    }
    if ( !currentUser ) return;
    setLoading( true );
    if ( isFaved ) {
      setIsFaved( false );
      deleteFaveMutate( { uuid } );
    } else {
      setIsFaved( true );
      createFaveMutate( { uuid } );
    }
  }, [
    currentUser,
    createFaveMutate,
    deleteFaveMutate,
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

  return (
    <INatIconButton
      icon={isFaved
        ? "star"
        : "star-bold-outline"}
      size={iconSize}
      width={buttonWidth}
      height={buttonHeight}
      onPress={toggleFave}
      color={colors.white}
      className={classNames( positionClassName )}
      accessibilityLabel={isFaved
        ? t( "Remove-favorite" )
        : t( "Add-favorite" )}
    />
  );
};

export default FaveButton;
