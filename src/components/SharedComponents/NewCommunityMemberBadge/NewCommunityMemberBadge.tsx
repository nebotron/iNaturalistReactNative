import { Pressable } from "components/styledComponents";
import React, { useCallback, useState } from "react";
import { Text } from "react-native";
import { useTranslation } from "sharedHooks";

import NewCommunityMemberSheet from "./NewCommunityMemberSheet";

interface Props {
  testID?: string;
}

const NewCommunityMemberBadge = ( { testID = "NewCommunityMemberBadge" }: Props ) => {
  const { t } = useTranslation( );
  const [showSheet, setShowSheet] = useState( false );

  const showExplanation = useCallback( ( ) => {
    setShowSheet( true );
  }, [] );

  const closeSheet = useCallback( ( ) => {
    setShowSheet( false );
  }, [] );

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t( "New-community-member" )}
        accessibilityHint={t( "Shows-information-about-new-community-members" )}
        className="ml-1"
        hitSlop={8}
        testID={testID}
        onPress={showExplanation}
      >
        <Text maxFontSizeMultiplier={1}>{t( "New-community-member-duckling" )}</Text>
      </Pressable>
      <NewCommunityMemberSheet
        hidden={!showSheet}
        onPressClose={closeSheet}
      />
    </>
  );
};

export default NewCommunityMemberBadge;
