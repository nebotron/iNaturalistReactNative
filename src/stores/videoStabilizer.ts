import type { StabilizeMethod, VideoAnalysis } from "sharedHelpers/videoStabilization";
import type { VideoFrame, VideoInfo } from "sharedHelpers/videoStabilizerNative";
import { create } from "zustand";

// The video stabilizer's session. Held here rather than in the screen so that
// a tab switch or a trip to the camera, which unmounts the screen, doesn't
// throw away an analysis that took a minute to run. Not persisted: the working
// files it points at live in Caches and can be purged.

export type BusyPhase = "importing" | "analyzing" | "previewing" | "exporting";

interface Busy {
  phase: BusyPhase;
  progress: number;
}

export interface VideoStabilizerState {
  videoPath: string | null;
  info: VideoInfo | null;
  frame: VideoFrame | null;
  // Where the output starts, in seconds; the box and crop are drawn on the
  // frame at this time.
  start: number;
  method: StabilizeMethod;
  // [x, y, w, h], normalized, top-left origin, on the start frame.
  box: number[] | null;
  // Background methods: crop center, normalized, on the start frame.
  cropCenter: { x: number; y: number } | null;
  strength: number;
  lockSize: boolean;
  zoom: number;
  avoidEdges: boolean;
  includeAudio: boolean;
  analysis: VideoAnalysis | null;
  busy: Busy | null;
  previewUri: string | null;
  exportUri: string | null;
  set: ( partial: Partial<VideoStabilizerState> ) => void;
  // Changes that make the motion analysis stale.
  setMethod: ( method: StabilizeMethod ) => void;
  setBox: ( box: number[] | null ) => void;
  setStart: ( start: number ) => void;
  reset: ( ) => void;
}

const initialSession = {
  videoPath: null,
  info: null,
  frame: null,
  start: 0,
  method: "similarity" as StabilizeMethod,
  box: null,
  cropCenter: null,
  strength: 0.5,
  lockSize: false,
  zoom: 1,
  avoidEdges: true,
  includeAudio: true,
  analysis: null,
  busy: null,
  previewUri: null,
  exportUri: null,
};

const staleResults = { analysis: null, previewUri: null, exportUri: null };

const useVideoStabilizer = create<VideoStabilizerState>( set => ( {
  ...initialSession,
  set: partial => set( partial ),
  setMethod: method => set( { method, ...staleResults } ),
  setBox: box => set( { box, ...staleResults } ),
  setStart: start => set( {
    start, box: null, cropCenter: null, ...staleResults,
  } ),
  reset: ( ) => set( initialSession ),
} ) );

export default useVideoStabilizer;
