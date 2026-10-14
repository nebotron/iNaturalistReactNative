// @flow
import ObsMediaDisplay from "components/ObsDetailsSharedComponents/Media/ObsMediaDisplay";
import compact from "lodash/compact";
import type { Node } from "react";
import React, { useMemo } from "react";
import { useCurrentUser } from "sharedHooks";

type Props = {
  observation: Object,
  tablet?: boolean
}

// TODO replace this hack. Without this you get errors about the
// photo objects being invalidated down in ObsMedia, but the
// questions remains, why are these objects getting invalidated in
// the first place? We are not deleting them, so what's happening
// to them and why?
function jsonifyPotentialRealmObjects( objects ) {
  return compact(
    Array.from( objects || [] ).map(
      object => (
        object.toJSON
          ? object.toJSON( )
          : object
      ),
    ),
  );
}

const ObsMediaDisplayContainer = ( {
  observation,
  tablet = false,
}: Props ): Node => {
  const currentUser = useCurrentUser( );
  // Only auto-frame to the detected subject for other people's observations.
  // The user's own photos are cropped in the crop editor, not auto-detected
  // when simply viewing them.
  const belongsToCurrentUser = observation?.user?.login === currentUser?.login;
  const photos = useMemo( ( ) => jsonifyPotentialRealmObjects(
    (
      observation?.observationPhotos
      || observation?.observation_photos
      || []
    ).map( op => op.photo ),
  ), [observation] );
  const sounds = useMemo(
    ( ) => jsonifyPotentialRealmObjects(
      (
        observation?.observationSounds
        || observation?.observation_sounds
        || []
      ).map( os => os.sound ),
    ),
    [observation],
  );

  return (
    <ObsMediaDisplay
      autoDetectSubject={!belongsToCurrentUser}
      loading={!observation}
      latitude={observation?.latitude}
      longitude={observation?.longitude}
      photos={photos}
      sounds={sounds}
      tablet={tablet}
      timeObservedAt={observation?.time_observed_at}
    />
  );
};

export default ObsMediaDisplayContainer;
