import {
  BottomSheet,
  Button,
  List2,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";

interface Props {
  hidden?: boolean;
  onPressClose: ( ) => void;
}

const NewCommunityMemberSheet = ( {
  hidden,
  onPressClose,
}: Props ) => {
  const { t } = useTranslation( );

  return (
    <BottomSheet
      headerText={t( "New-community-member" )}
      hidden={hidden}
      onPressClose={onPressClose}
    >
      <View className="mx-[26px] space-y-[11px] my-[15px]">
        <List2 className="text-darkGray">
          {t( "New-community-member-explanation" )}
        </List2>
      </View>
      <View className="flex-row mx-3 mb-3">
        <Button
          text={t( "OK" )}
          onPress={onPressClose}
          className="mx-2 flex-1"
          level="primary"
          testID="NewCommunityMemberSheet.okButton"
        />
      </View>
    </BottomSheet>
  );
};

export default NewCommunityMemberSheet;
