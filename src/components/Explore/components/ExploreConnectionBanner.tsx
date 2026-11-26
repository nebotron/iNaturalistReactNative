import { Body3 } from "components/SharedComponents";
import { Pressable } from "components/styledComponents";
import React, { useState } from "react";
import { formatDifferenceForHumans } from "sharedHelpers/dateAndTime";
import { useTranslation } from "sharedHooks";

// Past this the age reads as a date, which doesn't fit "from … ago"
const MAX_AGE_SHOWN_MS = 30 * 24 * 60 * 60 * 1000;

interface Props {
  offline: boolean;
  // When the results shown were fetched, if they're cached ones
  dataUpdatedAt?: number;
  onRetry: ( ) => void;
}

// Says the results shown aren't the latest, offline or after failing to fetch
// them, above the results rather than in their place
const ExploreConnectionBanner = ( { offline, dataUpdatedAt, onRetry }: Props ) => {
  const { t, i18n } = useTranslation( );
  // When the banner appeared, which is close enough for an age in hours or days
  const [shownAt] = useState( ( ) => Date.now( ) );
  const age = dataUpdatedAt
    ? shownAt - dataUpdatedAt
    : null;
  const timeAgo = age !== null && age >= 0 && age < MAX_AGE_SHOWN_MS
    ? formatDifferenceForHumans( new Date( dataUpdatedAt as number ), i18n )
    : null;
  let text: string;
  if ( offline ) {
    text = timeAgo
      ? t( "Offline-showing-results-from-time-ago", { timeAgo } )
      : t( "You-are-offline-Tap-to-try-again" );
  } else {
    text = t( "Couldnt-load-the-latest-results-Tap-to-try-again" );
  }
  return (
    <Pressable
      className="mx-5 mb-2 px-3 py-2 rounded-lg bg-lightGray"
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityHint={t( "Tries-to-load-the-latest-results" )}
      onPress={onRetry}
      testID="ExploreConnectionBanner"
    >
      <Body3>{text}</Body3>
    </Pressable>
  );
};

export default ExploreConnectionBanner;
