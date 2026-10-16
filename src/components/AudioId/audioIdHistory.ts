import { DocumentDirectoryPath, readFile, unlink } from "@dr.pogodin/react-native-fs";
import { isCurrentUser } from "components/LoginSignUp/AuthenticationService";
import Config from "react-native-config";
import createMmkvRecordStore, { AUDIO_ID_CLIPS_MMKV_ID } from "sharedHelpers/mmkvRecordStore";
import * as uuid from "uuid";
import { create } from "zustand";

import type { AudioIdSpecies } from "./audioIdModel";

// Every Audio ID detection, kept with a 5 s clip of the call
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
  sp: AudioIdSpecies;
  time: number;
  confidence: number;
  label?: AudioIdLabel;
  location?: { latitude: number; longitude: number; accuracy: number };
  // the observation last made from this clip
  observationUuid?: string;
}

// The app container's path changes across installs, so only ids are stored.
export const clipPath = ( id: string ) => `${CLIPS_PATH}/${id}.m4a`;
// 15 s centered on the clip, uploaded with labels.
export const contextClipPath = ( id: string ) => `${CLIPS_PATH}/${id}-15s.m4a`;

// The clip heard closest to `time`, if any was within AROUND_MS of it.
export const AROUND_MS = 10000;
export const clipAround = ( clips: Record<string, AudioIdClip>, time: number ) => Object
  .values( clips )
  .filter( clip => Math.abs( clip.time - time ) <= AROUND_MS )
  .sort( ( a, b ) => Math.abs( a.time - time ) - Math.abs( b.time - time ) )[0];

interface AudioIdHistoryState {
  clips: Record<string, AudioIdClip>;
  addClip: ( sp: AudioIdSpecies, confidence: number ) => AudioIdClip;
  updateClip: ( id: string, changes: Partial<AudioIdClip> ) => void;
  labelClip: (
    id: string, taxonId: number | null | undefined, name: string | null
  ) => Promise<void>;
  unlabelClip: ( id: string ) => void;
  tagClip: ( id: string, correct: boolean ) => void;
  deleteClip: ( id: string ) => void;
}

// Whether the user tagged the clip's ID right (true) or wrong (false).
export const isClipCorrect = ( clip: AudioIdClip ) => ( clip.label
  ? clip.label.taxonId === clip.sp.taxonId
  : undefined );

// One key per clip, so a detection writes only its own clip
const clipStore = createMmkvRecordStore<AudioIdClip>( AUDIO_ID_CLIPS_MMKV_ID );
clipStore.migrateFrom( "audio-id-history", "clips" );

const useAudioIdHistory = create<AudioIdHistoryState>( )( ( set, get ) => ( {
  clips: clipStore.loadAll( ),
  addClip: ( sp, confidence ) => {
    const clip = {
      id: uuid.v4( ), sp, time: Date.now( ), confidence,
    };
    set( { clips: { ...get( ).clips, [clip.id]: clip } } );
    clipStore.put( clip.id, clip );
    return clip;
  },
  updateClip: ( id, changes ) => {
    const clip = get( ).clips[id];
    if ( !clip ) return;
    const updated = { ...clip, ...changes };
    set( { clips: { ...get( ).clips, [id]: updated } } );
    clipStore.put( id, updated );
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
        latitude: clip.location?.latitude ?? null,
        longitude: clip.location?.longitude ?? null,
        positionalAccuracy: clip.location?.accuracy ?? null,
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
  unlabelClip: id => get( ).updateClip( id, { label: undefined } ),
  tagClip: ( id, correct ) => {
    const clip = get( ).clips[id];
    if ( !clip ) return;
    // Tapping the same tag again undoes it.
    if ( isClipCorrect( clip ) === correct ) get( ).unlabelClip( id );
    else if ( correct ) get( ).labelClip( id, clip.sp.taxonId, clip.sp.name );
    else get( ).labelClip( id, undefined, null );
  },
  deleteClip: id => {
    const { [id]: _deleted, ...clips } = get( ).clips;
    set( { clips } );
    clipStore.remove( id );
    unlink( clipPath( id ) ).catch( ( ) => undefined );
    unlink( contextClipPath( id ) ).catch( ( ) => undefined );
  },
} ) );

export default useAudioIdHistory;
