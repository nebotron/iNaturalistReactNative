import type { LayoutSlice } from "stores/createLayoutSlice";
import useStore from "stores/useStore";
import { useShallow } from "zustand/react/shallow";

// Wraps values from the layout slice with descriptive names
const selector = ( state : LayoutSlice ) => ( {
  // Vestigial stuff
  obsDetailsTab: state.obsDetailsTab,
  setObsDetailsTab: state.setObsDetailsTab,
  loggedInWhileInDefaultMode: state.loggedInWhileInDefaultMode,
  setLoggedInWhileInDefaultMode: state.setLoggedInWhileInDefaultMode,
  // newer stuff
  ...state.layout,
} );

// The selector builds a new object every time it runs, so without an equality
// check Zustand sees a changed value on every state change anywhere in the
// store and re-renders every component using this hook. Layout prefs barely
// ever change, but the rest of the store changes constantly -- upload
// progress, sync counters, each photo of an import landing -- and this hook is
// used by every row of My Observations and Notifications, the observation
// list, the AI camera and its frame processor, so a screen's worth of
// components was re-rendering many times a second while any of that ran. That
// is JS-thread time the app can't spend answering a tap.
const useLayoutPrefs = ( ) => useStore( useShallow( selector ) );

export default useLayoutPrefs;
