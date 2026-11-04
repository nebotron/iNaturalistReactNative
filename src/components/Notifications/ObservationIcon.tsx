import type { ApiObservation } from "api/types";
import { THUMBNAIL_CLASS } from "appConstants/classNames";
import classnames from "classnames";
import { soundUriFromObservation } from "components/ObservationsFlashList/util";
import {
  CachedImage,
  INatIcon,
} from "components/SharedComponents";
import SoundPlayButton from "components/SharedComponents/SoundPlayButton";
import { View } from "components/styledComponents";
import * as React from "react";
import colors from "styles/tailwindColors";

interface Props {
  observation?: ApiObservation;
}

const ObservationIcon = ( {
  observation,
}: Props ) => {
  const photoUri = observation?.observation_photos?.[0]?.photo?.url;
  const soundUri = soundUriFromObservation( observation );
  if ( !photoUri && !soundUri ) {
    return (
      <View
        className={classnames(
          THUMBNAIL_CLASS,
          "bg-white",
          "border-[2px]",
          "justify-center",
          "items-center",
        )}
      >
        <INatIcon
          name="noevidence"
          size={24}
          color={String( colors?.darkGray )}
        />
      </View>
    );
  }

  if ( !photoUri && soundUri ) {
    return (
      <View
        className={classnames(
          THUMBNAIL_CLASS,
          "bg-white",
          "border-[2px]",
          "justify-center",
          "items-center",
        )}
      >
        <SoundPlayButton uri={soundUri} size={24} color={String( colors?.darkGray )} />
      </View>
    );
  }

  return (
    <View>
      <CachedImage
        testID="ObservationIcon.photo"
        className={THUMBNAIL_CLASS}
        source={{ uri: photoUri }}
        accessibilityRole="image"
      />
      { soundUri && (
        <View className="absolute left-0 bottom-0">
          <SoundPlayButton uri={soundUri} size={16} color={colors.white} dropShadow />
        </View>
      ) }
    </View>
  );
};

export default ObservationIcon;
