import type { NearbyCoords } from "components/Explore/ExploreV2/helpers/buildQueryParams";
import type { ExploreV2State } from "providers/ExploreV2Context";
import type { Region } from "react-native-maps";
import type { StateCreator } from "zustand";

// How the Explore tab looked when it was last on screen, so leaving the tab
// (which can unmount it, see agent-docs/architecture/realm-and-zustand.md) and
// coming back puts the user where they were. Held in memory only: after a
// relaunch the search is restored from lastExploreSearch, but the viewport
// and scroll positions start over.

interface ExploreMapView {
  // Where the user left the map
  region: Region;
  // Identifies the search the map was showing. While it is unchanged, the map
  // stays at `region` instead of moving back to frame the search.
  targetKey: string;
  // Whether the user had panned away from the search, so "Redo search in this
  // area" shows again
  panned: boolean;
}

// Scroll offsets kept, beyond which the oldest are dropped
const MAX_SCROLL_OFFSETS = 50;

export interface ExploreSessionSlice {
  exploreSessionState: ExploreV2State | null;
  setExploreSessionState: ( _state: ExploreV2State ) => void;
  exploreNearbyCoords: NearbyCoords | null;
  setExploreNearbyCoords: ( _coords: NearbyCoords | null ) => void;
  exploreMapView: ExploreMapView | null;
  setExploreMapView: ( _view: ExploreMapView ) => void;
  // Keyed by list and the search it shows, so a different search starts at the top
  listScrollOffsets: Record<string, number>;
  setListScrollOffset: ( _key: string, _offset: number ) => void;
}

const createExploreSessionSlice: StateCreator<ExploreSessionSlice> = set => ( {
  exploreSessionState: null,
  setExploreSessionState: exploreSessionState => set( { exploreSessionState } ),
  exploreNearbyCoords: null,
  setExploreNearbyCoords: exploreNearbyCoords => set( { exploreNearbyCoords } ),
  exploreMapView: null,
  setExploreMapView: exploreMapView => set( { exploreMapView } ),
  listScrollOffsets: {},
  setListScrollOffset: ( key, offset ) => set( state => {
    const { [key]: _previous, ...others } = state.listScrollOffsets;
    if ( offset <= 0 ) return { listScrollOffsets: others };
    const keys = Object.keys( others );
    keys.slice( 0, Math.max( 0, keys.length - MAX_SCROLL_OFFSETS + 1 ) )
      .forEach( oldKey => { delete others[oldKey]; } );
    // Re-added last so it's the newest
    return { listScrollOffsets: { ...others, [key]: offset } };
  } ),
} );

export default createExploreSessionSlice;
