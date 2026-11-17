import {
  act, fireEvent, screen, userEvent, waitFor,
} from "@testing-library/react-native";
import VideoStabilizer from "components/VideoStabilizer/VideoStabilizer";
import { HOLD_MS } from "components/VideoStabilizer/ZoomRectangle";
import initI18next from "i18n/initI18next";
import i18next from "i18next";
import React from "react";
import { ScrollView, StyleSheet } from "react-native";
import useVideoStabilizer from "stores/videoStabilizer";
import { renderComponent } from "tests/helpers/render";

const mockPickVideo = jest.fn( );
const mockAnalyze = jest.fn( );
const mockRender = jest.fn( );
const mockPlay = jest.fn( );
const mockSave = jest.fn( );

jest.mock( "sharedHelpers/videoStabilizerNative", ( ) => ( {
  isVideoStabilizerSupported: ( ) => true,
  isCancellation: ( ) => false,
  onVideoStabilizerProgress: ( ) => ( ) => undefined,
  cancelVideoStabilizer: jest.fn( ),
  clearVideoStabilizerFiles: ( ) => Promise.resolve( ),
  pickVideo: ( ...args: unknown[] ) => mockPickVideo( ...args ),
  probeVideo: ( ) => Promise.resolve( {
    width: 1920, height: 1080, duration: 4, fps: 30, hasAudio: true,
  } ),
  videoFrameAt: ( ) => Promise.resolve( { uri: "file:///frame.jpg", width: 1080, height: 608 } ),
  analyzeVideo: ( ...args: unknown[] ) => mockAnalyze( ...args ),
  renderStabilizedVideo: ( ...args: unknown[] ) => mockRender( ...args ),
  playVideo: ( ...args: unknown[] ) => mockPlay( ...args ),
  saveStabilizedVideo: ( ...args: unknown[] ) => mockSave( ...args ),
  VideoStabilizerComparison: jest.requireActual( "react-native" ).View,
} ) );

jest.mock( "sharedHelpers/promptDeleteOriginalDevicePhotos", ( ) => ( {
  enqueuePhotoLibraryWrite: (
    write: ( hold: ( p: Promise<unknown> ) => void ) => Promise<unknown>,
  ) => write( ( ) => undefined ),
} ) );

const INPUT = "/caches/VideoStabilizer/input.mov";

const analysis = {
  width: 1920,
  height: 1080,
  fps: 30,
  refinedFrames: 0,
  frames: [0, 1, 2].map( i => ( {
    t: i / 30, ok: true, m: [1, 0, i, 0, 1, -i, 0, 0, 1],
  } ) ),
};

const importVideo = async ( user: ReturnType<typeof userEvent.setup> ) => {
  await user.press( screen.getByText( i18next.t( "IMPORT-FROM-PHOTOS" ) ) );
  await waitFor( ( ) => expect( mockAnalyze ).toHaveBeenCalled( ) );
};

describe( "VideoStabilizer", ( ) => {
  beforeAll( async ( ) => {
    await initI18next( );
  } );

  beforeEach( ( ) => {
    jest.clearAllMocks( );
    useVideoStabilizer.getState( ).reset( );
    mockPickVideo.mockResolvedValue( INPUT );
    mockAnalyze.mockResolvedValue( analysis );
    mockRender.mockImplementation( ( _path, options ) => Promise.resolve( {
      uri: options.preview
        ? "file:///caches/VideoStabilizer/preview.mov"
        : "file:///caches/VideoStabilizer/out.mov",
      frames: 3,
    } ) );
    mockSave.mockResolvedValue( undefined );
  } );

  it( "only imports from Photos", ( ) => {
    renderComponent( <VideoStabilizer /> );
    expect( screen.getByText( i18next.t( "IMPORT-FROM-PHOTOS" ) ) ).toBeVisible( );
    expect( screen.queryByText( "IMPORT FROM FILES" ) ).toBeNull( );
  } );

  it( "analyzes and previews on import, then exports with sound", async ( ) => {
    const user = userEvent.setup( );
    renderComponent( <VideoStabilizer /> );
    await importVideo( user );
    expect( mockPickVideo ).toHaveBeenCalledWith( );
    expect( mockAnalyze ).toHaveBeenCalledWith(
      INPUT,
      expect.objectContaining( { start: 0, mode: "background" } ),
    );
    await waitFor( ( ) => expect( mockRender ).toHaveBeenCalledWith(
      INPUT,
      expect.objectContaining( { preview: true } ),
    ) );
    expect( await screen.findByText(
      i18next.t( "Motion-analyzed-across-x-frames", { count: 3 } ),
    ) ).toBeVisible( );

    await user.press( screen.getByText( i18next.t( "EXPORT" ) ) );
    await waitFor( ( ) => expect( mockRender ).toHaveBeenCalledWith(
      INPUT,
      expect.objectContaining( { preview: false } ),
    ) );
    const options = mockRender.mock.calls.find( call => !call[1].preview )[1];
    expect( options.transforms ).toHaveLength( 3 * 9 );
    expect( options ).toEqual( expect.objectContaining( {
      outputWidth: 1920, outputHeight: 1080,
    } ) );
    expect( options ).not.toHaveProperty( "includeAudio" );

    await user.press( await screen.findByText( i18next.t( "SAVE-TO-PHOTOS" ) ) );
    expect( mockSave ).toHaveBeenCalledWith( "file:///caches/VideoStabilizer/out.mov", INPUT, 0 );
  } );

  it( "doesn't hide black edges by default", async ( ) => {
    const user = userEvent.setup( );
    renderComponent( <VideoStabilizer /> );
    await importVideo( user );
    expect( screen.getByRole( "switch", {
      name: i18next.t( "Zoom-in-to-hide-empty-edges" ),
    } ) ).not.toBeChecked( );
  } );

  it( "tracks the subject when stabilizing the subject", async ( ) => {
    const user = userEvent.setup( );
    renderComponent( <VideoStabilizer /> );
    await importVideo( user );
    await waitFor( ( ) => expect( mockRender ).toHaveBeenCalled( ) );
    await user.press( screen.getByTestId( "VideoStabilizer.mode.subject" ) );
    await waitFor( ( ) => expect( mockAnalyze ).toHaveBeenLastCalledWith(
      INPUT,
      expect.objectContaining( { mode: "subject", subject: { x: 0.5, y: 0.5 } } ),
    ) );
    expect( mockAnalyze ).toHaveBeenCalledTimes( 2 );
    expect( screen.getByText( i18next.t( "Tap-the-subject-to-follow-it" ) ) ).toBeVisible( );
  } );

  it( "zooms to a rectangle drawn after touching and holding the stabilized preview", async ( ) => {
    const user = userEvent.setup( );
    renderComponent( <VideoStabilizer /> );
    await importVideo( user );
    expect( await screen.findByText(
      i18next.t( "Motion-analyzed-across-x-frames", { count: 3 } ),
    ) ).toBeVisible( );
    expect( screen.getByText( i18next.t( "Crop-zoom-x", { zoom: "1.0" } ) ) ).toBeVisible( );

    const overlay = screen.getByAccessibilityHint(
      i18next.t( "Zooms-to-the-rectangle-drawn-after-touching-and-holding" ),
    );
    const { width, height } = StyleSheet.flatten( overlay.props.style );
    const at = ( x: number, y: number ) => ( {
      nativeEvent: { locationX: x, locationY: y },
      touchHistory: { touchBank: [] },
    } );
    const scrollEnabled = ( ) => screen.UNSAFE_getByType( ScrollView ).props.scrollEnabled;

    // A swipe that moves before the hold elapses is a scroll, not a rectangle.
    fireEvent( overlay, "responderGrant", at( width / 2, height / 4 ) );
    expect( overlay.props.onResponderTerminationRequest( ) ).toBe( true );
    fireEvent( overlay, "responderMove", at( width / 2, height ) );
    await act( ( ) => new Promise( resolve => { setTimeout( resolve, HOLD_MS + 50 ); } ) );
    fireEvent( overlay, "responderMove", at( width, height ) );
    fireEvent( overlay, "responderRelease", at( width, height ) );
    expect( scrollEnabled( ) ).toBe( true );
    expect( screen.getByText( i18next.t( "Crop-zoom-x", { zoom: "1.0" } ) ) ).toBeVisible( );

    // Half the width, so 2×, centered three quarters of the way across.
    // The drag runs past the bottom; the box keeps the video's aspect.
    fireEvent( overlay, "responderGrant", at( width / 2, height / 4 ) );
    await act( ( ) => new Promise( resolve => { setTimeout( resolve, HOLD_MS + 50 ); } ) );
    expect( scrollEnabled( ) ).toBe( false );
    fireEvent( overlay, "responderMove", at( width, height ) );
    fireEvent( overlay, "responderRelease", at( width, height ) );

    expect( scrollEnabled( ) ).toBe( true );
    expect( screen.getByText( i18next.t( "Crop-zoom-x", { zoom: "2.0" } ) ) ).toBeVisible( );
    const { cropCenter } = useVideoStabilizer.getState( );
    expect( cropCenter?.x ).toBeCloseTo( 0.75, 1 );
    expect( cropCenter?.y ).toBeCloseTo( 0.5, 1 );

    await user.press( screen.getByText( i18next.t( "RESET-ZOOM" ) ) );
    expect( screen.getByText( i18next.t( "Crop-zoom-x", { zoom: "1.0" } ) ) ).toBeVisible( );
    expect( useVideoStabilizer.getState( ).cropCenter ).toBeNull( );
  } );
} );
