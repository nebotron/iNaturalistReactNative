import { CachesDirectoryPath, exists, unlink } from "@dr.pogodin/react-native-fs";
import type { ViewProps } from "react-native";
import {
  NativeEventEmitter, NativeModules, Platform, requireNativeComponent,
} from "react-native";
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

// Starting an analysis or a render cancels the one before. `job` comes back
// on progress events, so a superseded job's progress can be told apart.
export interface AnalyzeOptions {
  method: StabilizeMethod;
  start: number;
  // Also measure every frame against the first, for a complete lock.
  reference: boolean;
  job: number;
}

export interface NativeAnalysis extends VideoAnalysis {
  // Frames the lock against the first frame could refine.
  refinedFrames: number;
}

export interface RenderOptions {
  start: number;
  // Nine numbers per frame: the row-major homography from source pixels to
  // output pixels, top-left origin.
  transforms: number[];
  outputWidth: number;
  outputHeight: number;
  // Previews and exports are kept separately, so a preview doesn't replace
  // the export the user is about to save.
  preview: boolean;
  job: number;
}

export interface RenderResult {
  uri: string;
  frames: number;
}

export type ProgressPhase = "analyze" | "render";

interface VideoStabilizerModule {
  pickVideo: ( ) => Promise<string | null>;
  probe: ( path: string ) => Promise<VideoInfo>;
  frameAt: ( path: string, seconds: number, maxDimension: number ) => Promise<VideoFrame>;
  analyze: ( path: string, options: AnalyzeOptions ) => Promise<NativeAnalysis>;
  render: ( path: string, options: RenderOptions ) => Promise<RenderResult>;
  cancel: ( ) => void;
  play: ( path: string ) => void;
  saveToPhotos: ( path: string, original: string, start: number ) => Promise<void>;
}

const nativeModule = Platform.OS === "ios"
  ? ( NativeModules as { VideoStabilizer?: VideoStabilizerModule } ).VideoStabilizer
  : undefined;

export const isVideoStabilizerSupported = ( ) => !!nativeModule;

const unavailable = ( ) => Promise.reject( new Error( "Video stabilization is unavailable" ) );

export const pickVideo = ( ) => nativeModule?.pickVideo( ) ?? Promise.resolve( null );

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

// Saves with the original's capture date (moved on to where the copy starts)
// and location, which Photos would otherwise replace with the time of saving.
export const saveStabilizedVideo = ( path: string, original: string, start: number ) => (
  nativeModule?.saveToPhotos( path, original, start ) ?? unavailable( )
);

// Looping, muted-until-unmuted inline player. Registered once here:
// requireNativeComponent throws when a name is registered twice.
export const VideoStabilizerPlayer = nativeModule
  ? requireNativeComponent<ViewProps & { uri: string }>( "VideoStabilizerPlayer" )
  : null;

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
  listener: ( event: { phase: ProgressPhase; progress: number; job: number | null } ) => void,
) => {
  if ( !nativeModule ) return ( ) => undefined;
  const subscription = new NativeEventEmitter( nativeModule as never )
    .addListener( "VideoStabilizerProgress", listener );
  return ( ) => subscription.remove( );
};
