import { screen, userEvent, waitFor } from "@testing-library/react-native";
import VideoStabilizer from "components/VideoStabilizer/VideoStabilizer";
import initI18next from "i18n/initI18next";
import i18next from "i18next";
import React from "react";
import useVideoStabilizer from "stores/videoStabilizer";
import { renderComponent } from "tests/helpers/render";

const mockPickVideo = jest.fn( );
const mockAnalyze = jest.fn( );
const mockRender = jest.fn( );
const mockPlay = jest.fn( );

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
} ) );

const analysis = {
  method: "similarity",
  width: 1920,
  height: 1080,
  fps: 30,
  registrationReading: "as-is",
  registrationVotes: 3,
  frames: [0, 1, 2].map( i => ( {
    t: i / 30, ok: true, m: [1, 0, i, 0, 1, -i, 0, 0, 1],
  } ) ),
};

describe( "VideoStabilizer", ( ) => {
  beforeAll( async ( ) => {
    await initI18next( );
  } );

  beforeEach( ( ) => {
    jest.clearAllMocks( );
    useVideoStabilizer.getState( ).reset( );
    mockPickVideo.mockResolvedValue( "/caches/VideoStabilizer/input.mov" );
    mockAnalyze.mockResolvedValue( analysis );
    mockRender.mockResolvedValue( { uri: "file:///caches/VideoStabilizer/out.mov", frames: 3 } );
  } );

  it( "imports, analyzes and exports a video", async ( ) => {
    const user = userEvent.setup( );
    renderComponent( <VideoStabilizer /> );

    await user.press( screen.getByText( i18next.t( "IMPORT-FROM-PHOTOS" ) ) );
    expect( mockPickVideo ).toHaveBeenCalledWith( "library" );
    const analyze = await screen.findByText( i18next.t( "ANALYZE-MOTION" ) );
    expect( screen.getByText( i18next.t( "EXPORT" ) ) ).toBeDisabled( );

    await user.press( analyze );
    await waitFor( ( ) => {
      expect( mockAnalyze ).toHaveBeenCalledWith(
        "/caches/VideoStabilizer/input.mov",
        expect.objectContaining( { method: "similarity", start: 0 } ),
      );
    } );
    expect( await screen.findByText(
      i18next.t( "Motion-analyzed-across-x-frames", { count: 3 } ),
    ) ).toBeVisible( );

    await user.press( screen.getByText( i18next.t( "EXPORT" ) ) );
    await waitFor( ( ) => expect( mockRender ).toHaveBeenCalled( ) );
    const options = mockRender.mock.calls[0][1];
    expect( options.transforms ).toHaveLength( 3 * 6 );
    expect( options ).toEqual( expect.objectContaining( {
      outputWidth: 1920, outputHeight: 1080, includeAudio: true, preview: false,
    } ) );
    expect( await screen.findByText( i18next.t( "SAVE-TO-PHOTOS" ) ) ).toBeVisible( );
  } );

  it( "asks for a subject box before tracking", async ( ) => {
    const user = userEvent.setup( );
    renderComponent( <VideoStabilizer /> );
    await user.press( screen.getByText( i18next.t( "IMPORT-FROM-PHOTOS" ) ) );
    await user.press( await screen.findByText( i18next.t( "SUBJECT--stabilize-on" ) ) );
    expect( screen.getByText(
      i18next.t( "Drag-on-the-frame-to-draw-a-box-around-the-subject" ),
    ) ).toBeVisible( );
    await user.press( screen.getByText( i18next.t( "ANALYZE-MOTION" ) ) );
    expect( mockAnalyze ).not.toHaveBeenCalled( );
  } );
} );
