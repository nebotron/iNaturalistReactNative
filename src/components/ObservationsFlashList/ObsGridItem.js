// @flow

import FaveButton from "components/ObsDetails/FaveButton";
import ObsImageActionButtons from "components/ObsDetails/ObsImageActionButtons";
import { Body2, DisplayTaxonName } from "components/SharedComponents";
import { View } from "components/styledComponents";
import type { Node } from "react";
import React, { useMemo } from "react";
import Photo from "realmModels/Photo";

import useTopSpeciesSuggestion from "./hooks/useTopSpeciesSuggestion";
import ObsImagePreview from "./ObsImagePreview";
import ObsUploadStatus from "./ObsUploadStatus";
import {
  observationHasSound,
  photoCountFromObservation,
  photoFromObservation,
  photosFromObservation,
} from "./util";

type Props = {
  currentUser: Object,
  explore: boolean,
  height?: string,
  hideObsUploadStatus?: boolean,
  observation: Object,
  onExploreObservationAction?: Function,
  onUploadButtonPress: Function,
  style?: Object,
  queued: boolean,
  uploadProgress?: number,
  width?: string,
  testID?: string,
  squareCorners?: boolean,
};

const ObsGridItem = ( {
  currentUser,
  explore,
  height = "h-[200px]",
  hideObsUploadStatus,
  observation,
  onExploreObservationAction,
  onUploadButtonPress,
  queued,
  style,
  uploadProgress,
  testID,
  width = "w-[200px]",
  squareCorners = false,
}: Props ): Node => {
  const showExploreImageActions = explore
    && currentUser;
  const isOwnObs = !!currentUser && observation?.user?.login === currentUser?.login;
  const topSpeciesSuggestion = useTopSpeciesSuggestion( observation, explore );
  const displayTaxon = topSpeciesSuggestion || observation?.taxon;
  const displayTaxonName = useMemo( ( ) => (
    <DisplayTaxonName
      bottomTextComponent={Body2}
      color="text-white"
      ellipsizeCommonName
      keyBase={observation?.uuid}
      layout="vertical"
      prefersCommonNames={currentUser?.prefers_common_names}
      scientificNameFirst={currentUser?.prefers_scientific_name_first}
      showOneNameOnly
      taxon={displayTaxon}
    />
  ), [
    currentUser?.prefers_common_names,
    currentUser?.prefers_scientific_name_first,
    displayTaxon,
    observation?.uuid,
  ] );

  const photo = photoFromObservation( observation );
  // On the Me page ( non-explore ) the photo count renders at the bottom-right,
  // so reserve space to keep a long species name from overlapping it.
  const reservePhotoCountSpace = !explore
    && photoCountFromObservation( observation ) > 1;
  const allPhotos = useMemo( ( ) => photosFromObservation( observation ).map(
    p => ( { uri: Photo.displayLocalOrRemoteOriginalPhoto( p ) } ),
  ), [observation] );

  return (
    <ObsImagePreview
      key={observation.uuid}
      autoBrightness={explore && !isOwnObs}
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
      isMultiplePhotosTop={explore}
      testID={testID || `MyObservations.obsGridItem.${observation.uuid}`}
      useShortGradient={!explore}
      iconicTaxonName={observation.taxon?.iconic_taxon_name}
      white
      squareCorners={squareCorners}
    >
      {showExploreImageActions && (
        <ObsImageActionButtons
          observation={observation}
          currentUser={currentUser}
          afterAction={onExploreObservationAction}
          directAgree
          suggestedTaxon={topSpeciesSuggestion}
        />
      )}
      {!explore && currentUser && (
        <FaveButton
          observation={observation}
          currentUser={currentUser}
        />
      )}
      <View
        className={`absolute bottom-0 left-0 right-0 items-start p-2${
          reservePhotoCountSpace
            ? " pr-10"
            : ""
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
      </View>
    </ObsImagePreview>
  );
};

export default ObsGridItem;
