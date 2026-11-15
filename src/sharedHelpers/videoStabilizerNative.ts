import { CachesDirectoryPath, exists, unlink } from "@dr.pogodin/react-native-fs";
import { NativeEventEmitter, NativeModules, Platform } from "react-native";
import type { StabilizeMethod, VideoAnalysis } from "sharedHelpers/videoStabilization";

// JS side of the VideoStabilizer native module (iOS only). The native side
// reads and writes video; the camera-path math is in videoStabilization.ts.

export interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
}

export interface VideoFrame {
  uri: string;
  width: number;
  height: number;
}

export interface AnalyzeOptions {
  method: StabilizeMethod;
  start: number;
  // Tracker (required) and saliency (optional hint): [x, y, w, h], normalized,
  // top-left origin, in the frame at `start`.
  box?: number[];
}

export interface NativeAnalysis extends VideoAnalysis {
  registrationReading: string;
  registrationVotes: number;
}

export interface RenderOptions {
  start: number;
  // Six numbers per frame: the affine (a, b, c, d, e, f) from source pixels
  // to output pixels, top-left origin.
  transforms: number[];
  outputWidth: number;
  outputHeight: number;
  includeAudio: boolean;
  // Previews and exports are kept separately, so a preview doesn't replace
  // the export the user is about to save.
  preview: boolean;
}

export interface RenderResult {
  uri: string;
  frames: number;
}

export type ProgressPhase = "analyze" | "render";

interface VideoStabilizerModule {
  pickVideo: ( source: "library" | "files" ) => Promise<string | null>;
  probe: ( path: string ) => Promise<VideoInfo>;
  frameAt: ( path: string, seconds: number, maxDimension: number ) => Promise<VideoFrame>;
  analyze: ( path: string, options: AnalyzeOptions ) => Promise<NativeAnalysis>;
  render: ( path: string, options: RenderOptions ) => Promise<RenderResult>;
  cancel: ( ) => void;
  play: ( path: string ) => void;
}

const nativeModule = Platform.OS === "ios"
  ? ( NativeModules as { VideoStabilizer?: VideoStabilizerModule } ).VideoStabilizer
  : undefined;

export const isVideoStabilizerSupported = ( ) => !!nativeModule;

const unavailable = ( ) => Promise.reject( new Error( "Video stabilization is unavailable" ) );

export const pickVideo = ( source: "library" | "files" ) => (
  nativeModule?.pickVideo( source ) ?? Promise.resolve( null )
);

export const probeVideo = ( path: string ) => nativeModule?.probe( path ) ?? unavailable( );

export const videoFrameAt = ( path: string, seconds: number, maxDimension = 1080 ) => (
  nativeModule?.frameAt( path, seconds, maxDimension ) ?? unavailable( )
);

export const analyzeVideo = ( path: string, options: AnalyzeOptions ) => (
  nativeModule?.analyze( path, options ) ?? unavailable( )
);

export const renderStabilizedVideo = ( path: string, options: RenderOptions ) => (
  nativeModule?.render( path, options ) ?? unavailable( )
);

export const cancelVideoStabilizer = ( ) => nativeModule?.cancel( );

export const playVideo = ( path: string ) => nativeModule?.play( path );

// The native side keeps one session's files (the imported copy, frames,
// preview and export) in Caches/VideoStabilizer. The imported copy alone can
// be gigabytes, so it's removed as soon as the user is done with it rather
// than left for iOS to purge.
const workingDirectory = `${CachesDirectoryPath}/VideoStabilizer`;

export const clearVideoStabilizerFiles = async ( ) => {
  if ( await exists( workingDirectory ) ) await unlink( workingDirectory );
};

export const isCancellation = ( error: unknown ) => (
  ( error as { code?: string } | null )?.code === "CANCELLED"
);

export const onVideoStabilizerProgress = (
  listener: ( event: { phase: ProgressPhase; progress: number } ) => void,
) => {
  if ( !nativeModule ) return ( ) => undefined;
  const subscription = new NativeEventEmitter( nativeModule as never )
    .addListener( "VideoStabilizerProgress", listener );
  return ( ) => subscription.remove( );
};
