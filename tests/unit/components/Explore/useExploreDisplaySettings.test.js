import { act, renderHook } from "@testing-library/react-native";
import {
  EXPLORE_LAYOUT_KEY,
  HOTSPOT_EXPLORE_LAYOUT_KEY,
  useExploreGridOverlays,
  useExploreLayoutKey,
} from "components/Explore/hooks/useExploreDisplaySettings";
import { ExploreProvider, initialExploreState } from "providers/ExploreContext";
import React from "react";
import useStore from "stores/useStore";

const wrapperFor = fromHotspot => function Wrapper( { children } ) {
  return (
    <ExploreProvider initialState={initialExploreState} fromHotspot={fromHotspot}>
      {children}
    </ExploreProvider>
  );
};

const initialLayout = useStore.getState( ).layout;

describe( "useExploreDisplaySettings", ( ) => {
  beforeEach( ( ) => {
    useStore.setState( { layout: initialLayout } );
  } );

  it( "uses a layout of its own in Explore opened from a hotspot link", ( ) => {
    const { result: hotspot } = renderHook( useExploreLayoutKey, { wrapper: wrapperFor( true ) } );
    const { result: tab } = renderHook( useExploreLayoutKey, { wrapper: wrapperFor( false ) } );
    expect( hotspot.current ).toBe( HOTSPOT_EXPLORE_LAYOUT_KEY );
    expect( tab.current ).toBe( EXPLORE_LAYOUT_KEY );
  } );

  it( "follows the Explore tab's overlays until changed from a hotspot link", ( ) => {
    useStore.getState( ).layout.setExploreGridOverlay( "lens", true );
    const { result } = renderHook( useExploreGridOverlays, { wrapper: wrapperFor( true ) } );
    expect( result.current.overlays.lens ).toBe( true );

    act( ( ) => result.current.setOverlay( "iso", true ) );
    const { layout } = useStore.getState( );
    expect( layout.hotspotGridOverlays.iso ).toBe( true );
    expect( layout.hotspotGridOverlays.lens ).toBe( true );
    expect( layout.exploreGridOverlays.iso ).toBe( false );
  } );

  it( "leaves the hotspot overlays alone when changed in the Explore tab", ( ) => {
    const { result } = renderHook( useExploreGridOverlays, { wrapper: wrapperFor( true ) } );
    act( ( ) => result.current.setOverlay( "iso", true ) );
    useStore.getState( ).layout.setExploreGridOverlay( "lens", true );
    expect( useStore.getState( ).layout.hotspotGridOverlays.lens ).toBe( false );
  } );
} );
