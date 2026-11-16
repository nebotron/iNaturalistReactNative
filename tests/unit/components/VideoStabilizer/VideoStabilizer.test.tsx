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
  VideoStabilizerComparison: null,
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
      expect.objectContaining( { start: 0, reference: false } ),
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

  it( "analyzes again when holding the background completely still", async ( ) => {
    const user = userEvent.setup( );
    renderComponent( <VideoStabilizer /> );
    await importVideo( user );
    await waitFor( ( ) => expect( mockRender ).toHaveBeenCalled( ) );
    await user.press( screen.getByText( i18next.t( "Hold-the-background-completely-still" ) ) );
    await waitFor( ( ) => expect( mockAnalyze ).toHaveBeenLastCalledWith(
      INPUT,
      expect.objectContaining( { reference: true } ),
    ) );
    expect( mockAnalyze ).toHaveBeenCalledTimes( 2 );
  } );

  it( "plays the original video", async ( ) => {
    const user = userEvent.setup( );
    renderComponent( <VideoStabilizer /> );
    await importVideo( user );
    await user.press( screen.getByText( i18next.t( "PLAY-ORIGINAL" ) ) );
    expect( mockPlay ).toHaveBeenCalledWith( INPUT );
  } );
} );
