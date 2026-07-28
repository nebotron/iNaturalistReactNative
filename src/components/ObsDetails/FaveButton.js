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

const { useRealm } = RealmContext;

const OBS_IMAGE_ACTION_ICON_SIZE = 50;
const WHITE_OVERLAY_COLOR = "rgba(255, 255, 255, 0.7)";

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

  // Mirrors the fave state onto the local Realm record. This has to happen for
  // uploaded observations too, not just unuploaded ones: nothing else refreshes
  // votes when faving from a list (e.g. the MyObservations grid), so without it
  // Realm keeps a stale fave and features that read it — Delete Unfaved — never
  // see the change.
  const writeLocalFave = useCallback( faved => {
    if ( realm.isClosed || !uuid ) return;
    // observation may be a plain object mapped for display (e.g. on the
    // MyObservations screen), so look up the Realm-managed record by uuid
    // rather than writing directly to the prop we were passed.
    const realmObservation = realm.objectForPrimaryKey( "Observation", uuid );
    if ( !realmObservation || !realmObservation.isValid( ) ) return;
    const userId = currentUser?.id || 0;
    safeRealmWrite( realm, ( ) => {
      const otherVotes = ( realmObservation.votes || [] )
        // Drop this user's fave; other users' faves and scoped votes stay put.
        // user_id 0 is the placeholder used when faving while logged out.
        .filter( v => !(
          v?.vote_scope === null && ( v?.user_id === userId || v?.user_id === 0 )
        ) )
        .map( v => ( {
          id: v.id,
          created_at: v.created_at,
          user_id: v.user_id,
          vote_flag: v.vote_flag,
          vote_scope: v.vote_scope,
        } ) );
      realmObservation.votes = faved
        ? [...otherVotes, {
          id: Math.floor( Math.random( ) * 1e9 ),
          user_id: userId,
          vote_flag: true,
          vote_scope: null,
        }]
        : otherVotes;
    }, "toggling favorite locally" );
  }, [realm, uuid, currentUser] );

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
        writeLocalFave( false );
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
        writeLocalFave( true );
        setLoading( false );
      },
    },
  );

  const toggleFave = useCallback( ( ) => {
    const newIsFaved = !isFaved;
    if ( isUnuploaded ) {
      setLoading( true );
      writeLocalFave( newIsFaved );
      setIsFaved( newIsFaved );
      setLoading( false );
      afterToggleFave( newIsFaved );
      return;
    }
    if ( !currentUser ) return;
    setLoading( true );
    setIsFaved( newIsFaved );
    // Optimistic: the server is the source of truth, but Realm has to reflect
    // the change now so a later refetch isn't the only thing that can. Reverted
    // in the mutation's onError below.
    writeLocalFave( newIsFaved );
    if ( newIsFaved ) {
      createFaveMutate( { uuid } );
    } else {
      deleteFaveMutate( { uuid } );
    }
  }, [
    currentUser,
    createFaveMutate,
    deleteFaveMutate,
    isFaved,
    uuid,
    isUnuploaded,
    writeLocalFave,
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
      color={WHITE_OVERLAY_COLOR}
      className={classNames( positionClassName )}
      accessibilityLabel={isFaved
        ? t( "Remove-favorite" )
        : t( "Add-favorite" )}
    />
  );
};

export default FaveButton;
