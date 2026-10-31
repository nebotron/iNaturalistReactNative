import mergeWith from "lodash/mergeWith";
import { holdKeepAwake, releaseKeepAwake } from "sharedHelpers/keepAwake";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ExploreSlice } from "./createExploreSlice";
import createExploreSlice from "./createExploreSlice";
import type { ExploreV2SearchesSlice } from "./createExploreV2SearchesSlice";
import createExploreV2SearchesSlice from "./createExploreV2SearchesSlice";
import type { FeatureFlagSlice } from "./createFeatureFlagSlice";
import createFeatureFlagSlice from "./createFeatureFlagSlice";
import type { FirebaseTraceSlice } from "./createFirebaseTraceSlice";
import createFirebaseTraceSlice from "./createFirebaseTraceSlice";
import type { LayoutSlice } from "./createLayoutSlice";
import createLayoutSlice from "./createLayoutSlice";
import type { MyObservationsSlice } from "./createMyObservationsSlice";
import createMyObservationsSlice from "./createMyObservationsSlice";
import type { ObservationFlowSlice } from "./createObservationFlowSlice";
import createObservationFlowSlice, { dropPendingGroupPhotos } from "./createObservationFlowSlice";
import type { RootExploreSlice } from "./createRootExploreSlice";
import createRootExploreSlice from "./createRootExploreSlice";
import type { SyncObservationsSlice } from "./createSyncObservationsSlice";
import createSyncObservationsSlice from "./createSyncObservationsSlice";
import type { UploadObservationsSlice } from "./createUploadObservationsSlice";
import createUploadObservationsSlice, { UPLOAD_IN_PROGRESS } from "./createUploadObservationsSlice";
import createFieldStorage from "./fieldPersistStorage";
import storage from "./zustandMMKVBackingStorage";

type StoreState =
  ExploreSlice
  & ExploreV2SearchesSlice
  & FeatureFlagSlice
  & FirebaseTraceSlice
  & LayoutSlice
  & MyObservationsSlice
  & ObservationFlowSlice
  & RootExploreSlice
  & SyncObservationsSlice
  & UploadObservationsSlice;

// TODO do *not* export this. This allows any consumer to overwrite *any* part
// of state, circumventing any getter/setter logic we have in the stores. If
// you need to modify state, you should be doing so through a store.
export const zustandStorage = {
  setItem: ( name: string, value: string | number ) => storage.set( name, value ),
  getItem: ( name: string ) => {
    const value = storage.getString( name ) || storage.getNumber( name );
    return value ?? null;
  },
  removeItem: ( name: string ) => storage.delete( name ),
};

// Everything in a namespaced slice except its setters, which can't be
// serialized and are recreated on every launch anyway
const persistableValues = ( namespace: object ) => Object.entries( namespace ).reduce(
  ( memo: Record<string, unknown>, [key, value] ) => {
    if ( typeof value !== "function" ) {
      memo[key] = value;
    }
    return memo;
  },
  {},
);

// Using slices to separate store for Explore and Observation creation flow
// https://docs.pmnd.rs/zustand/guides/slices-pattern
const useStore = create<StoreState>()( persist(
  ( ...args ) => {
    // Let's make our slices
    const slices = [
      createExploreV2SearchesSlice( ...args ),
      createExploreSlice( ...args ),
      createFeatureFlagSlice( ...args ),
      createFirebaseTraceSlice( ...args ),
      createLayoutSlice( ...args ),
      createMyObservationsSlice( ...args ),
      createObservationFlowSlice( ...args ),
      createRootExploreSlice( ...args ),
      createSyncObservationsSlice( ...args ),
      createUploadObservationsSlice( ...args ),
    ];

    // Now let's make sure they're not clobbering each other because
    // everything in Zustand state exists in a single namespace and
    // clobbering can happen silently... which is bad.
    const allKeys = slices.map( slice => Object.keys( slice ) ).flat( );
    const keyCounts = allKeys.reduce(
      ( memo: Record<string, number>, curr ) => {
        memo[curr] ||= 0;
        memo[curr] += 1;
        return memo;
      },
      {},
    );
    const nonUniqueKeys = Object.keys( keyCounts ).reduce(
      ( memo: string[], curr ) => {
        if ( keyCounts[curr] > 1 ) memo.push( curr );
        return memo;
      },
      [],
    );
    if ( nonUniqueKeys.length > 0 ) {
      throw new Error(
        `You have multiple Zustand slices with the following keys: ${nonUniqueKeys}`,
      );
    }

    // All good? Now let's combine them into one enormous hideous object
    return slices.reduce(
      ( memo, curr ) => ( { ...memo, ...curr } ),
      {},
    ) as StoreState;
  },
  {
    name: "persisted-zustand",
    partialize: state => ( {
      // Vestigial un-namespaced values in the layout slice
      isAdvancedUser: state.isAdvancedUser,
      obsDetailsTab: state.obsDetailsTab,

      // Dynamically select all values in the layout slice's namespace
      layout: persistableValues( state.layout ),

      exploreSavedSearches: {
        searches: state.exploreSavedSearches.searches,
      },
      lastExploreSearch: state.lastExploreSearch,

      // Last location used in the location picker
      lastLocationPickerState: state.lastLocationPickerState,

      // Group Photos progress, so it survives an app kill. Photos still being
      // copied out of the library are left out: their copies die with the
      // process, so restoring them would resume an import stuck on cells that
      // can never fill in.
      groupedPhotos: dropPendingGroupPhotos( state.groupedPhotos ),
      firstObservationDefaults: state.firstObservationDefaults,
      pendingGroupPhotoDeletionUris: state.pendingGroupPhotoDeletionUris,
      groupCropResume: state.groupCropResume,

      // Explore tab filters and related search state
      rootExploreView: state.rootExploreView,
      rootRelativeDateOffsets: state.rootRelativeDateOffsets,
      rootStoredParams: state.rootStoredParams,
      savedExploreFilters: state.savedExploreFilters,
    } ),
    storage: createFieldStorage( storage ),
    // We need to deep merge to persist nested objects, like layout
    // https://zustand.docs.pmnd.rs/middlewares/persist#persisting-a-state-with-nested-objects
    // Arrays must be replaced wholesale rather than merged index-by-index:
    // lodash's default array merging leaves stale trailing elements behind
    // when the persisted array (e.g. groupedPhotos cleared after a Group
    // Photos import) is shorter than what's currently in memory.
    merge: ( persisted, current ) => mergeWith( current, persisted, ( _objValue, srcValue ) => (
      Array.isArray( srcValue )
        ? srcValue
        : undefined
    ) ),
  },
) );

// Hold the screen awake for exactly as long as an upload is in progress, however
// the status leaves that state (complete, cancelled, reset, or set directly).
useStore.subscribe( ( state, prev ) => {
  if ( state.uploadStatus === prev.uploadStatus ) return;
  if ( state.uploadStatus === UPLOAD_IN_PROGRESS ) holdKeepAwake( "upload" );
  else releaseKeepAwake( "upload" );
} );

// A log of crops that nothing ever read, rewritten in full on every crop and
// photo upload until it was removed
storage.delete( "cropFeedbackLog" );

export default useStore;
