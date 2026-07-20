import { useCallback, useEffect, useState } from "react";
import mmkvStorage from "stores/zustandMMKVBackingStorage";
import { zustandStorage } from "stores/useStore";

interface LayoutHook {
  layout: string | null;
  writeLayoutToStorage: ( newValue: string ) => void;
}

const useStoredLayout = ( storageKey: string ): LayoutHook => {
  const [layout, setLayout] = useState<string | null>( null );

  const writeLayoutToStorage = useCallback( ( newValue: string ) => {
    zustandStorage.setItem( storageKey, newValue );
    setLayout( newValue );
  }, [storageKey] );

  useEffect( ( ) => {
    const defaultLayout = storageKey === "exploreObservationsLayout"
      ? "map"
      : "grid";
    // Casting is necessary because zustandStorage.getItem returns string | number | null
    const storedLayout = zustandStorage.getItem( storageKey ) as string | null;
    setLayout( storedLayout || defaultLayout );

    const listener = mmkvStorage.addOnValueChangedListener( changedKey => {
      if ( changedKey !== storageKey ) return;
      const updated = zustandStorage.getItem( storageKey ) as string | null;
      setLayout( updated || defaultLayout );
    } );

    return ( ) => listener.remove( );
  }, [storageKey] );

  return {
    layout,
    writeLayoutToStorage,
  };
};

export default useStoredLayout;
