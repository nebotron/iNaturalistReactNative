import { useCallback, useEffect, useState } from "react";
import { zustandStorage } from "stores/useStore";
import mmkvStorage from "stores/zustandMMKVBackingStorage";

interface LayoutHook {
  layout: string | null;
  writeLayoutToStorage: ( newValue: string ) => void;
}

// Keeps its pre-rename value so users' saved Explore layout survives
export const EXPLORE_LAYOUT_STORAGE_KEY = "exploreV2ObservationsLayout";

const MAP_DEFAULT_STORAGE_KEYS = [
  EXPLORE_LAYOUT_STORAGE_KEY,
  "hotspotExploreObservationsLayout",
];

const defaultLayoutFor = ( storageKey: string ) => (
  MAP_DEFAULT_STORAGE_KEYS.includes( storageKey )
    ? "map"
    : "grid"
);

// Casting is necessary because zustandStorage.getItem returns string | number | null
const readLayout = ( storageKey: string ) => (
  zustandStorage.getItem( storageKey ) as string | null
) || defaultLayoutFor( storageKey );

const useStoredLayout = ( storageKey: string ): LayoutHook => {
  // MMKV reads are synchronous, so read on the first render: screens render nothing until
  // they have a layout, and waiting for an effect cost them a blank frame on every mount
  const [layout, setLayout] = useState<string | null>( ( ) => readLayout( storageKey ) );
  const [layoutKey, setLayoutKey] = useState( storageKey );
  if ( layoutKey !== storageKey ) {
    setLayoutKey( storageKey );
    setLayout( readLayout( storageKey ) );
  }

  const writeLayoutToStorage = useCallback( ( newValue: string ) => {
    zustandStorage.setItem( storageKey, newValue );
    setLayout( newValue );
  }, [storageKey] );

  useEffect( ( ) => {
    const listener = mmkvStorage.addOnValueChangedListener( changedKey => {
      if ( changedKey !== storageKey ) return;
      setLayout( readLayout( storageKey ) );
    } );

    return ( ) => listener.remove( );
  }, [storageKey] );

  return {
    layout,
    writeLayoutToStorage,
  };
};

export default useStoredLayout;
