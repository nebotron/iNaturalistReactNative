import type { VideoAnalysis } from "sharedHelpers/videoStabilization";
import type { VideoInfo } from "sharedHelpers/videoStabilizerNative";
import { create } from "zustand";

// The video stabilizer's session. Held here rather than in the screen so that
// a tab switch or a trip to the camera, which unmounts the screen, doesn't
// throw away an analysis that took a minute to run. Not persisted: the working
// files it points at live in Caches and can be purged.

export type BusyPhase = "importing" | "analyzing" | "previewing" | "exporting";

interface Busy {
  phase: BusyPhase;
  progress: number;
  // The native job this is for, to match its progress events.
  job?: number;
}

interface VideoStabilizerState {
  videoPath: string | null;
  info: VideoInfo | null;
  // Where the output starts, in seconds.
  start: number;
  // Crop center, normalized, on the start frame.
  cropCenter: { x: number; y: number } | null;
  zoom: number;
  avoidEdges: boolean;
  // Each result remembers the settings it was made with (see the screen's
  // analysisKey and previewKey), so a change makes it stale without a
  // separate invalidation step, and the screen reruns what's out of date.
  analysis: VideoAnalysis | null;
  analysisKey: string | null;
  busy: Busy | null;
  previewUri: string | null;
  previewKey: string | null;
  // The start time the preview was rendered from, so the original plays
  // beside it from the same frame even while a newer preview is on its way.
  previewStart: number;
  // The window the preview shows: its corners (top-left, top-right,
  // bottom-right, bottom-left), normalized, on the first source frame, and
  // the zoom it was rendered at. A rectangle dragged over the preview is
  // mapped through this to a new crop center and zoom.
  previewCrop: { corners: { x: number; y: number }[]; zoom: number } | null;
  exportUri: string | null;
  exportKey: string | null;
  set: ( partial: Partial<VideoStabilizerState> ) => void;
  setStart: ( start: number ) => void;
  reset: ( ) => void;
}

const initialSession = {
  videoPath: null,
  info: null,
  start: 0,
  cropCenter: null,
  zoom: 1,
  avoidEdges: false,
  analysis: null,
  analysisKey: null,
  busy: null,
  previewUri: null,
  previewKey: null,
  previewStart: 0,
  previewCrop: null,
  exportUri: null,
  exportKey: null,
};

const useVideoStabilizer = create<VideoStabilizerState>( set => ( {
  ...initialSession,
  set: partial => set( partial ),
  // The crop center was picked on the old start frame.
  setStart: start => set( { start, cropCenter: null } ),
  reset: ( ) => set( initialSession ),
} ) );

export default useVideoStabilizer;
