import { useCallback, useEffect, useState } from "react";
import { zustandStorage } from "stores/useStore";
import mmkvStorage from "stores/zustandMMKVBackingStorage";

interface LayoutHook {
  layout: string | null;
  writeLayoutToStorage: ( newValue: string ) => void;
}

const MAP_DEFAULT_STORAGE_KEYS = ["exploreObservationsLayout", "exploreV2ObservationsLayout"];

const useStoredLayout = ( storageKey: string ): LayoutHook => {
  const [layout, setLayout] = useState<string | null>( null );

  const writeLayoutToStorage = useCallback( ( newValue: string ) => {
    zustandStorage.setItem( storageKey, newValue );
    setLayout( newValue );
  }, [storageKey] );

  useEffect( ( ) => {
    const defaultLayout = MAP_DEFAULT_STORAGE_KEYS.includes( storageKey )
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
