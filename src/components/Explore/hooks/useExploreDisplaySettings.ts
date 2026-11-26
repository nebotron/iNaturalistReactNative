import { useExploreFromHotspot } from "providers/ExploreContext";
import { useCallback } from "react";
import type { ExploreGridOverlays } from "stores/createLayoutSlice";
import useStore from "stores/useStore";

export const EXPLORE_LAYOUT_KEY = "exploreV2ObservationsLayout";
// Explore opened from a hotspot link keeps a layout of its own
export const HOTSPOT_EXPLORE_LAYOUT_KEY = "hotspotExploreObservationsLayout";

// The MMKV key holding this Explore's map/grid/list layout
export const useExploreLayoutKey = ( ) => ( useExploreFromHotspot( )
  ? HOTSPOT_EXPLORE_LAYOUT_KEY
  : EXPLORE_LAYOUT_KEY );

// This Explore's grid overlays and their setter. Explore opened from a hotspot
// link has its own, following the Explore tab's until first changed there.
export const useExploreGridOverlays = ( ) => {
  const fromHotspot = useExploreFromHotspot( );
  const overlays = useStore( state => ( fromHotspot
    ? state.layout.hotspotGridOverlays ?? state.layout.exploreGridOverlays
    : state.layout.exploreGridOverlays ) );
  const setOverlay = useStore( state => ( fromHotspot
    ? state.layout.setHotspotGridOverlay
    : state.layout.setExploreGridOverlay ) );
  const replaceOverlays = useCallback( ( next: ExploreGridOverlays ) => {
    useStore.setState( state => ( {
      layout: {
        ...state.layout,
        [fromHotspot
          ? "hotspotGridOverlays"
          : "exploreGridOverlays"]: next,
      },
    } ) );
  }, [fromHotspot] );
  return { overlays, setOverlay, replaceOverlays };
};
