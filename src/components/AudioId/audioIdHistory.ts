import { DocumentDirectoryPath, readFile } from "@dr.pogodin/react-native-fs";
import { isCurrentUser } from "components/LoginSignUp/AuthenticationService";
import Config from "react-native-config";
import { zustandStorage } from "stores/useStore";
import * as uuid from "uuid";
import { create } from "zustand";
import type { StateStorage } from "zustand/middleware";
import { createJSONStorage, persist } from "zustand/middleware";

import type { AudioIdSpecies } from "./audioIdModel";

// Every Audio ID detection, kept across sessions with a 5 s clip of the call
// (saved natively as AAC under CLIPS_PATH). A detection is one call: runs of
// a species heard less than 3 s apart; its clip is the run it scored best in.
// Labels ben142 gives a clip are mirrored to Firebase for checking the model.

const CLIPS_PATH = `${DocumentDirectoryPath}/audioIdClips`;

export interface AudioIdLabel {
  // null when the user says no organism is in the clip; undefined when they
  // only say the ID is wrong
  taxonId?: number | null;
  name: string | null;
  labeledAt: number;
}
export interface AudioIdClip {
  id: string;
  sessionId?: string;
  sp: AudioIdSpecies;
  time: number;
  confidence: number;
  label?: AudioIdLabel;
}

// One stretch of listening; endedAt is unset if the app quit while listening.
export interface ListeningSession {
  id: string;
  startedAt: number;
  endedAt?: number;
}

// The app container's path changes across installs, so only ids are stored.
export const clipPath = ( id: string ) => `${CLIPS_PATH}/${id}.m4a`;
// 15 s centered on the clip, uploaded with labels.
export const contextClipPath = ( id: string ) => `${CLIPS_PATH}/${id}-15s.m4a`;

interface AudioIdHistoryState {
  clips: Record<string, AudioIdClip>;
  sessions: Record<string, ListeningSession>;
  startSession: ( ) => string;
  endSession: ( id: string ) => void;
  addClip: ( sp: AudioIdSpecies, confidence: number, sessionId?: string ) => AudioIdClip;
  updateClip: ( id: string, changes: Partial<AudioIdClip> ) => void;
  labelClip: (
    id: string, taxonId: number | null | undefined, name: string | null
  ) => Promise<void>;
  tagClip: ( id: string, correct: boolean ) => void;
}

// Whether the user tagged the clip's ID right (true) or wrong (false).
export const isClipCorrect = ( clip: AudioIdClip ) => ( clip.label
  ? clip.label.taxonId === clip.sp.taxonId
  : undefined );

const useAudioIdHistory = create<AudioIdHistoryState>( )( persist( ( set, get ) => ( {
  clips: {},
  sessions: {},
  startSession: ( ) => {
    const id = uuid.v4( );
    set( { sessions: { ...get( ).sessions, [id]: { id, startedAt: Date.now( ) } } } );
    return id;
  },
  endSession: id => {
    const session = get( ).sessions[id];
    if ( session ) {
      set( { sessions: { ...get( ).sessions, [id]: { ...session, endedAt: Date.now( ) } } } );
    }
  },
  addClip: ( sp, confidence, sessionId ) => {
    const clip = {
      id: uuid.v4( ), sessionId, sp, time: Date.now( ), confidence,
    };
    set( { clips: { ...get( ).clips, [clip.id]: clip } } );
    return clip;
  },
  updateClip: ( id, changes ) => {
    const clip = get( ).clips[id];
    if ( clip ) set( { clips: { ...get( ).clips, [id]: { ...clip, ...changes } } } );
  },
  labelClip: async ( id, taxonId, name ) => {
    const clip = get( ).clips[id];
    if ( !clip ) return;
    const label = { taxonId, name, labeledAt: Date.now( ) };
    get( ).updateClip( id, { label } );
    const correct = taxonId === clip.sp.taxonId;
    const baseUrl = Config.CROP_LOG_FIREBASE_URL;
    if ( !baseUrl || !( await isCurrentUser( "ben142" ) ) ) return;
    fetch( `${baseUrl}/audio_id_labels/${id}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify( {
        predictedTaxonId: clip.sp.taxonId,
        predictedName: clip.sp.name,
        confidence: clip.confidence,
        heardAt: new Date( clip.time ).toISOString( ),
        correct,
        labelTaxonId: taxonId ?? null,
        labelName: name,
        noOrganism: taxonId === null,
        labeledAt: new Date( label.labeledAt ).toISOString( ),
      } ),
    } ).catch( ( ) => undefined );
    // The audio goes in its own path so the labels stay quick to download.
    // Clips from before 15 s ones were saved fall back to the 5 s clip.
    readFile( contextClipPath( id ), "base64" )
      .catch( ( ) => readFile( clipPath( id ), "base64" ) ).then( audio => fetch(
        `${baseUrl}/audio_id_clips/${id}.json`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify( { format: "m4a", audioBase64: audio } ),
        },
      ) ).catch( ( ) => undefined );
  },
  tagClip: ( id, correct ) => {
    const clip = get( ).clips[id];
    if ( !clip ) return;
    if ( correct ) get( ).labelClip( id, clip.sp.taxonId, clip.sp.name );
    else get( ).labelClip( id, undefined, null );
  },
} ), {
  name: "audio-id-history",
  storage: createJSONStorage( ( ) => zustandStorage as unknown as StateStorage ),
  partialize: state => ( { clips: state.clips, sessions: state.sessions } ),
} ) );

export default useAudioIdHistory;
