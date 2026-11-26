import { TextInputSheet } from "components/SharedComponents";
import React from "react";
import type { GearKind } from "sharedHelpers/gearNicknames";
import { useGearNicknames, useTranslation } from "sharedHooks";

interface Props {
  kind: GearKind;
  // The camera or lens name read from EXIF
  name: string;
  insideModal?: boolean;
  onPressClose: ( ) => void;
}

// Sets or clears the nickname for a camera or lens
const GearNicknameSheet = ( {
  kind, name, insideModal, onPressClose,
}: Props ) => {
  const { t } = useTranslation( );
  const { nameGear, setGearNickname } = useGearNicknames( );
  return (
    <TextInputSheet
      headerText={kind === "camera"
        ? t( "Camera-nickname" )
        : t( "Lens-nickname" )}
      description={t( "Nickname-for-X-leave-empty-to-use-its-own-name", { name } )}
      initialInput={nameGear( kind, name )}
      insideModal={insideModal}
      maxLength={100}
      multiline={false}
      buttonText={t( "SAVE" )}
      onPressClose={onPressClose}
      confirm={input => {
        setGearNickname( kind, name, input ?? "" );
        return true;
      }}
    />
  );
};

export default GearNicknameSheet;
