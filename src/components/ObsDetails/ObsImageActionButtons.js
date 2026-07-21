// @flow
import { View } from "components/styledComponents";
import type { Node } from "react";
import React from "react";

import AgreeButton from "./AgreeButton";
import FaveButton from "./FaveButton";
import ReviewButton from "./ReviewButton";

type Props = {
  observation: Object,
  currentUser?: Object,
  afterAction?: Function,
  directAgree?: boolean,
  openAgreeWithIdSheet?: ( taxon: Object ) => void,
  containerClassName?: string,
  suggestedTaxon?: Object,
}

const ObsImageActionButtons = ( {
  observation,
  currentUser,
  afterAction = ( ) => undefined,
  directAgree = false,
  openAgreeWithIdSheet,
  containerClassName = "absolute bottom-2 right-2 z-10 flex-col items-end gap-9",
  suggestedTaxon,
}: Props ): Node => {
  if ( !currentUser || !observation ) {
    return null;
  }

  const isOwnObservation = observation?.user?.id === currentUser.id;

  return (
    <View className={containerClassName}>
      {isOwnObservation && (
        <FaveButton
          observation={observation}
          currentUser={currentUser}
          afterToggleFave={afterAction}
          stacked
        />
      )}
      <ReviewButton
        observation={observation}
        currentUser={currentUser}
        afterToggleReview={afterAction}
        stacked
      />
      <AgreeButton
        observation={observation}
        currentUser={currentUser}
        afterAgree={afterAction}
        directAgree={directAgree}
        openAgreeWithIdSheet={openAgreeWithIdSheet}
        suggestedTaxon={suggestedTaxon}
        stacked
      />
    </View>
  );
};

export default ObsImageActionButtons;
