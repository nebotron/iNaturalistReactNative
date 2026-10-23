// @flow

import classNames from "classnames";
import AudioIdClipBadge from "components/AudioId/AudioIdClipBadge";
import FaveButton from "components/ObsDetails/FaveButton";
import {
  Body2, Body4, DateDisplay, DisplayTaxonName, INatIcon,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import type { Node } from "react";
import React, { useMemo, useState } from "react";
import Photo from "realmModels/Photo";
import useStore from "stores/useStore";
import colors from "styles/tailwindColors";

import ObsImagePreview from "./ObsImagePreview";
import ObsUploadStatus from "./ObsUploadStatus";
import {
  observationHasSound,
  photoCountFromObservation,
  photoFromObservation,
  photosFromObservation,
  soundUriFromObservation,
} from "./util";

type Props = {
  currentUser: Object,
  explore: boolean,
  height?: string,
  hideObsUploadStatus?: boolean,
  observation: Object,
  onUploadButtonPress: Function,
  style?: Object,
  queued: boolean,
  uploadProgress?: number,
  width?: string,
  testID?: string,
  squareCorners?: boolean,
};

const WhiteBody4 = ( { className, children } ) => (
  <Body4 className={classNames( "text-white", className )} numberOfLines={1}>
    {children}
  </Body4>
);

const ObsGridItem = ( {
  currentUser,
  explore,
  height = "h-[200px]",
  hideObsUploadStatus,
  observation,
  onUploadButtonPress,
  queued,
  style,
  uploadProgress,
  testID,
  width = "w-[200px]",
  squareCorners = false,
}: Props ): Node => {
  const isOwnObs = !!currentUser && observation?.user?.login === currentUser?.login;
  const exploreOverlays = useStore( state => state.layout.exploreGridOverlays );
  const overlays = explore
    ? exploreOverlays
    : null;
  const showCommon = !overlays || overlays.commonName;
  const showScientific = !overlays || overlays.scientificName;
  const showFaveButton = ( !explore || overlays?.faveButton ) && !!currentUser;
  const faves = observation?.votes?.filter( v => v?.vote_scope === null ) || [];
  const initiallyFaved = faves.some( v => v.user_id === currentUser?.id );
  // Fave state after toggling here, so the count updates without a refetch
  const [faved, setFaved] = useState( initiallyFaved );
  const faveCount = faves.length + Number( faved ) - Number( initiallyFaved );
  const displayTaxonName = useMemo( ( ) => {
    if ( !showCommon && !showScientific ) return null;
    // Outside Explore, show one name per the user's preference
    const bothNames = !!overlays && showCommon && showScientific;
    return (
      <DisplayTaxonName
        bottomTextComponent={Body2}
        color="text-white"
        ellipsizeCommonName
        keyBase={observation?.uuid}
        layout="vertical"
        prefersCommonNames={overlays
          ? showCommon
          : currentUser?.prefers_common_names}
        scientificNameFirst={( !overlays || bothNames )
          && currentUser?.prefers_scientific_name_first}
        showOneNameOnly={!bothNames}
        taxon={observation?.taxon}
      />
    );
  }, [
    currentUser?.prefers_common_names,
    currentUser?.prefers_scientific_name_first,
    observation?.taxon,
    observation?.uuid,
    overlays,
    showCommon,
    showScientific,
  ] );

  const placeGuess = observation.private_place_guess || observation.place_guess;
  const photo = photoFromObservation( observation );
  // The photo count renders at the bottom-right unless the top-right is free
  // (Explore without the fave star), so reserve space to keep a long species
  // name from overlapping it.
  const photoCountTop = explore && !showFaveButton;
  const reservePhotoCountSpace = !photoCountTop
    && photoCountFromObservation( observation ) > 1;
  const allPhotos = useMemo( ( ) => photosFromObservation( observation ).map(
    p => ( { uri: Photo.displayLocalOrRemoteOriginalPhoto( p ) } ),
  ), [observation] );

  return (
    <ObsImagePreview
      key={observation.uuid}
      autoDetectSubject={explore && !isOwnObs}
      source={{
        uri: Photo.displayLocalOrRemoteOriginalPhoto( photo ),
      }}
      photos={allPhotos}
      width={squareCorners
        ? undefined
        : width}
      height={squareCorners
        ? undefined
        : height}
      style={style}
      obsPhotosCount={photoCountFromObservation( observation )}
      hasSound={observationHasSound( observation )}
      soundUri={soundUriFromObservation( observation )}
      isMultiplePhotosTop={photoCountTop}
      testID={testID || `MyObservations.obsGridItem.${observation.uuid}`}
      useShortGradient={!explore}
      iconicTaxonName={observation.taxon?.iconic_taxon_name}
      white
      squareCorners={squareCorners}
    >
      {showFaveButton && (
        <FaveButton
          observation={observation}
          currentUser={currentUser}
          afterToggleFave={setFaved}
        />
      )}
      {!explore && (
        <AudioIdClipBadge className="top-14 right-[22px]" observation={observation} />
      )}
      <View
        // Use explicit per-side padding when reserving space for the photo
        // count: a `p-2` + `pr-10` combo doesn't reliably override padding-right
        // in NativeWind, which let long species names run under the count icon.
        className={`absolute bottom-0 left-0 right-0 items-start ${
          reservePhotoCountSpace
            ? "pt-2 pb-2 pl-2 pr-12"
            : "p-2"
        }`}
      >
        {!hideObsUploadStatus && (
          <ObsUploadStatus
            classNameMargin="mb-1"
            explore={explore}
            layout="horizontal"
            observation={observation}
            onPress={onUploadButtonPress}
            queued={queued}
            progress={uploadProgress}
            white
          />
        )}
        {displayTaxonName}
        {overlays?.location && !!placeGuess && (
          <WhiteBody4 className="mt-1">{placeGuess}</WhiteBody4>
        )}
        {overlays?.dateTime && (
          <DateDisplay
            dateString={observation.time_observed_at || observation.observed_on}
            classNameMargin="mt-1"
            geoprivacy={observation.geoprivacy}
            taxonGeoprivacy={observation.taxon_geoprivacy}
            timeZone={observation.observed_time_zone}
            belongsToCurrentUser={isOwnObs}
            literalTime={!observation.observed_time_zone}
            hideIcon
            textComponent={WhiteBody4}
          />
        )}
        {overlays?.faveCount && (
          <View className="flex-row items-center mt-1">
            <INatIcon name="star" color={colors.white} size={12} />
            <WhiteBody4 className="ml-1">{faveCount}</WhiteBody4>
          </View>
        )}
      </View>
    </ObsImagePreview>
  );
};

export default ObsGridItem;
