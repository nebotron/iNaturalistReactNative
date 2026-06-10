// @flow

import ObsImageActionButtons from "components/ObsDetails/ObsImageActionButtons";
import { Body2, DisplayTaxonName } from "components/SharedComponents";
import { View } from "components/styledComponents";
import type { Node } from "react";
import React, { useMemo } from "react";
import Photo from "realmModels/Photo";

import ObsImagePreview from "./ObsImagePreview";
import ObsUploadStatus from "./ObsUploadStatus";
import {
  observationHasSound,
  photoCountFromObservation,
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
  const belongsToCurrentUser = observation?.user?.login === currentUser?.login;
  const showExploreImageActions = explore
    && currentUser
    && !belongsToCurrentUser;
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
      taxon={observation?.taxon}
    />
  ), [
    currentUser?.prefers_common_names,
    currentUser?.prefers_scientific_name_first,
    observation?.taxon,
    observation?.uuid,
  ] );

  const photos = photosFromObservation( observation );
  const sources = photos.map( p => ( { uri: Photo.displayLocalOrRemoteOriginalPhoto( p ) } ) );

  return (
    <ObsImagePreview
      autoDetectSubject={explore}
      sources={sources}
      width={squareCorners
        ? undefined
        : width}
      height={squareCorners
        ? undefined
        : height}
      style={style}
      obsPhotosCount={photoCountFromObservation( observation )}
      hasSound={observationHasSound( observation )}
      isMultiplePhotosTop
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
        />
      )}
      <View className="absolute bottom-0 items-start p-2">
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
