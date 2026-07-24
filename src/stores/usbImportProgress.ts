import { create } from "zustand";

// Transient UI state for the USB → Photos offload, driven by useUsbAutoImport
// and rendered by UsbImportProgress. Not persisted: it only reflects an
// in-progress offload and is cleared shortly after one finishes.
export type UsbImportPhase = "saving" | "deleting" | "done" | "error";

interface UsbImportProgressState {
  active: boolean;
  phase: UsbImportPhase;
  total: number;
  saved: number;
  failed: number;
  deleted: number;
  start: ( total: number ) => void;
  setCounts: ( saved: number, failed: number ) => void;
  setPhase: ( phase: UsbImportPhase ) => void;
  setDeleted: ( deleted: number ) => void;
  finish: ( ) => void;
}

const useUsbImportProgress = create<UsbImportProgressState>( set => ( {
  active: false,
  phase: "saving",
  total: 0,
  saved: 0,
  failed: 0,
  deleted: 0,
  start: total => set( {
    active: true, phase: "saving", total, saved: 0, failed: 0, deleted: 0,
  } ),
  setCounts: ( saved, failed ) => set( { saved, failed } ),
  setPhase: phase => set( { phase } ),
  setDeleted: deleted => set( { deleted } ),
  finish: ( ) => set( { active: false } ),
} ) );

export default useUsbImportProgress;
