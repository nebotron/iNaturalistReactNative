import { useCallback } from "react";
import type { GearKind } from "sharedHelpers/gearNicknames";
import { gearName } from "sharedHelpers/gearNicknames";
import useStore from "stores/useStore";

// The user's camera and lens nicknames, and a function naming gear with them
const useGearNicknames = ( ) => {
  const nicknames = useStore( state => state.layout.gearNicknames );
  const setGearNickname = useStore( state => state.layout.setGearNickname );
  const nameGear = useCallback(
    ( kind: GearKind, name?: string ) => gearName( nicknames, kind, name ),
    [nicknames],
  );
  return { nicknames, nameGear, setGearNickname };
};

export default useGearNicknames;
