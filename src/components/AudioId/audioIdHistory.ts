import { DocumentDirectoryPath, unlink } from "@dr.pogodin/react-native-fs";
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
// Labels the user gives a clip are mirrored to Firebase for checking the model.

const CLIPS_PATH = `${DocumentDirectoryPath}/audioIdClips`;
// Oldest clips of a species beyond this are deleted.
const MAX_CLIPS_PER_SPECIES = 100;

export interface AudioIdLabel {
  // null when the user says no organism is in the clip
  taxonId: number | null;
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

interface AudioIdHistoryState {
  clips: Record<string, AudioIdClip>;
  sessions: Record<string, ListeningSession>;
  startSession: ( ) => string;
  endSession: ( id: string ) => void;
  addClip: ( sp: AudioIdSpecies, confidence: number, sessionId?: string ) => AudioIdClip;
  updateClip: ( id: string, changes: Partial<AudioIdClip> ) => void;
  labelClip: ( id: string, taxonId: number | null, name: string | null ) => void;
}

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
    const clips = { ...get( ).clips, [clip.id]: clip };
    const ofSpecies = Object.values( clips )
      .filter( c => c.sp.taxonId === sp.taxonId )
      .sort( ( a, b ) => b.time - a.time );
    ofSpecies.slice( MAX_CLIPS_PER_SPECIES ).forEach( old => {
      delete clips[old.id];
      unlink( clipPath( old.id ) ).catch( ( ) => undefined );
    } );
    set( { clips } );
    return clip;
  },
  updateClip: ( id, changes ) => {
    const clip = get( ).clips[id];
    if ( clip ) set( { clips: { ...get( ).clips, [id]: { ...clip, ...changes } } } );
  },
  labelClip: ( id, taxonId, name ) => {
    const clip = get( ).clips[id];
    if ( !clip ) return;
    const label = { taxonId, name, labeledAt: Date.now( ) };
    get( ).updateClip( id, { label } );
    const baseUrl = Config.CROP_LOG_FIREBASE_URL;
    if ( !baseUrl ) return;
    fetch( `${baseUrl}/audio_id_labels/${id}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify( {
        predictedTaxonId: clip.sp.taxonId,
        predictedName: clip.sp.name,
        confidence: clip.confidence,
        heardAt: new Date( clip.time ).toISOString( ),
        labelTaxonId: taxonId,
        labelName: name,
        noOrganism: taxonId === null,
        labeledAt: new Date( label.labeledAt ).toISOString( ),
      } ),
    } ).catch( ( ) => undefined );
  },
} ), {
  name: "audio-id-history",
  storage: createJSONStorage( ( ) => zustandStorage as unknown as StateStorage ),
  partialize: state => ( { clips: state.clips, sessions: state.sessions } ),
} ) );

export default useAudioIdHistory;
