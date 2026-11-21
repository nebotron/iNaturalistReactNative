import { DocumentDirectoryPath, readFile, unlink } from "@dr.pogodin/react-native-fs";
import { isCurrentUser } from "components/LoginSignUp/AuthenticationService";
import Config from "react-native-config";
import createMmkvRecordStore, {
  AUDIO_ID_CLIPS_MMKV_ID, AUDIO_ID_UNSYNCED_LABELS_MMKV_ID,
} from "sharedHelpers/mmkvRecordStore";
import * as uuid from "uuid";
import { create } from "zustand";

import type { AudioIdSpecies } from "./audioIdModel";

// Every Audio ID detection, kept with a 5 s clip of the call
// (saved natively as AAC under CLIPS_PATH). A detection is one call: runs of
// a species heard less than 3 s apart; its clip is the run it scored best in.
// Labels ben142 gives a clip are mirrored to Firebase for checking the model.

const CLIPS_PATH = `${DocumentDirectoryPath}/audioIdClips`;

interface AudioIdLabel {
  // null when the user says no organism is in the clip; undefined when they
  // only say the ID is wrong
  taxonId?: number | null;
  name: string | null;
  labeledAt: number;
  // Firebase has the label and its audio, or isn't owed them
  synced?: boolean;
}
export interface AudioIdClip {
  id: string;
  sp: AudioIdSpecies;
  time: number;
  confidence: number;
  // What Identify gives the species for the call alone (see scoreTrim), once
  // the call is found
  callConfidence?: number;
  label?: AudioIdLabel;
  location?: { latitude: number; longitude: number; accuracy: number };
  // Seconds into the 15 s context clip the call fills, when found
  call?: [number, number];
  // Seconds into the clip's audio (the context clip, if kept) the user
  // trimmed it to, when they moved a handle
  trim?: [number, number];
  // The model's mean per-frame logit for the species in each 1/3 s of the
  // 15 s context clip, as the live session had it, or null where no run
  // covered that 1/3 s
  timeline?: ( number | null )[];
  // the observation last made from this clip
  observationUuid?: string;
  // Seconds the context clip lasts when it isn't the 15 s centered on the
  // call: a sound shared to the app is kept whole, ending at `time`.
  duration?: number;
  // Saved by hand while listening, whatever was heard: the last 15 s, kept
  // until deleted. Its `sp` is NO_SPECIES.
  manual?: boolean;
}

// A hand-saved clip's species: none.
export const NO_SPECIES: AudioIdSpecies = { name: "", commonName: "", taxonId: 0 };

// The app container's path changes across installs, so only ids are stored.
export const clipPath = ( id: string ) => `${CLIPS_PATH}/${id}.m4a`;
// 15 s centered on the clip, uploaded with labels.
export const contextClipPath = ( id: string ) => `${CLIPS_PATH}/${id}-15s.m4a`;

interface AudioIdHistoryState {
  clips: Record<string, AudioIdClip>;
  addClip: (
    sp: AudioIdSpecies, confidence: number, extra?: Partial<AudioIdClip>
  ) => AudioIdClip;
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

// Deleted clips whose label Firebase doesn't have yet, kept with their audio
// until it does: deleting a clip removes it from the device, not the label.
const unsyncedStore = createMmkvRecordStore<AudioIdClip>( AUDIO_ID_UNSYNCED_LABELS_MMKV_ID );
// Given up on after this long, so a label Firebase keeps refusing can't pile up
const UNSYNCED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Uploads still reading a clip's audio, so deleting the clip can wait for them.
const pendingUploads: Record<string, Promise<boolean>> = {};

const unlinkAudio = ( id: string ) => {
  unlink( clipPath( id ) ).catch( ( ) => undefined );
  unlink( contextClipPath( id ) ).catch( ( ) => undefined );
};

const put = ( url: string, body: object ) => fetch( url, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify( body ),
} ).then( response => response.ok, ( ) => false );

// Mirrors ben142's labels, with the audio, to Firebase. Resolves whether
// Firebase now has them (or isn't owed them); a failure is retried by
// retryLabelUploads.
const uploadLabel = async ( id: string, clip: AudioIdClip, label: AudioIdLabel ) => {
  const { taxonId, name } = label;
  const correct = taxonId === clip.sp.taxonId;
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl || !( await isCurrentUser( "ben142" ) ) ) return true;
  const labelPut = put( `${baseUrl}/audio_id_labels/${id}.json`, {
    predictedTaxonId: clip.sp.taxonId,
    predictedName: clip.sp.name,
    confidence: clip.confidence,
    callConfidence: clip.callConfidence ?? null,
    heardAt: new Date( clip.time ).toISOString( ),
    latitude: clip.location?.latitude ?? null,
    longitude: clip.location?.longitude ?? null,
    positionalAccuracy: clip.location?.accuracy ?? null,
    correct,
    labelTaxonId: taxonId ?? null,
    labelName: name,
    noOrganism: taxonId === null,
    labeledAt: new Date( label.labeledAt ).toISOString( ),
  } );
  // The audio goes in its own path so the labels stay quick to download.
  // Clips from before 15 s ones were saved fall back to the 5 s clip; a clip
  // with neither has no audio left to send.
  const audio = await readFile( contextClipPath( id ), "base64" )
    .catch( ( ) => readFile( clipPath( id ), "base64" ) ).catch( ( ) => null );
  const audioPut = audio === null
    ? true
    : put( `${baseUrl}/audio_id_clips/${id}.json`, { format: "m4a", audioBase64: audio } );
  const [labelOk, audioOk] = await Promise.all( [labelPut, audioPut] );
  return labelOk && audioOk;
};

// Uploads a clip's label and records once Firebase has it: on the clip if it's
// still in the history with that label, or by dropping the deleted clip kept
// for it.
const syncLabel = async ( clip: AudioIdClip, label: AudioIdLabel ) => {
  const { id } = clip;
  const upload = uploadLabel( id, clip, label );
  pendingUploads[id] = upload;
  const synced = await upload;
  if ( pendingUploads[id] === upload ) delete pendingUploads[id];
  if ( !synced ) return;
  // eslint-disable-next-line no-use-before-define
  const { clips, updateClip } = useAudioIdHistory.getState( );
  const current = clips[id];
  if ( current ) {
    if ( current.label?.labeledAt === label.labeledAt ) {
      updateClip( id, { label: { ...label, synced: true } } );
    }
    return;
  }
  const kept = unsyncedStore.get( id );
  if ( kept?.label?.labeledAt !== label.labeledAt ) return;
  unsyncedStore.remove( id );
  unlinkAudio( id );
};

const useAudioIdHistory = create<AudioIdHistoryState>( )( ( set, get ) => ( {
  clips: clipStore.loadAll( ),
  addClip: ( sp, confidence, extra = {} ) => {
    const clip = {
      id: uuid.v4( ), sp, time: Date.now( ), confidence, ...extra,
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
    await syncLabel( clip, label );
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
    const { [id]: clip, ...clips } = get( ).clips;
    set( { clips } );
    clipStore.remove( id );
    // Deleting only removes the clip from the device. A label Firebase doesn't
    // have yet stays, with its audio, until it does; otherwise a label upload
    // still reading the audio finishes first.
    if ( clip?.label && !clip.label.synced ) {
      unsyncedStore.put( id, clip );
      return;
    }
    Promise.resolve( pendingUploads[id] ).finally( ( ) => unlinkAudio( id ) );
  },
} ) );

// Detected clips, and their audio, are kept for three days; hand-saved ones
// until deleted.
const CLIP_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const expireOldClips = ( ) => {
  const { clips, deleteClip } = useAudioIdHistory.getState( );
  const cutoff = Date.now( ) - CLIP_TTL_MS;
  Object.values( clips )
    .filter( clip => !clip.manual && clip.time < cutoff )
    .forEach( clip => deleteClip( clip.id ) );
};

// Uploads labels Firebase never got, from the history and from deleted clips.
export const retryLabelUploads = async ( ) => {
  const { clips } = useAudioIdHistory.getState( );
  const cutoff = Date.now( ) - UNSYNCED_TTL_MS;
  const kept = Object.values( unsyncedStore.loadAll( ) ).filter( clip => {
    if ( clips[clip.id] ) {
      unsyncedStore.remove( clip.id );
      return false;
    }
    if ( !clip.label || clip.label.labeledAt < cutoff ) {
      unsyncedStore.remove( clip.id );
      unlinkAudio( clip.id );
      return false;
    }
    return true;
  } );
  const unsynced = [...Object.values( clips ), ...kept]
    .filter( clip => clip.label && !clip.label.synced && !pendingUploads[clip.id] );
  // One at a time: each sends a clip's audio
  // eslint-disable-next-line no-restricted-syntax
  for ( const clip of unsynced ) {
    // eslint-disable-next-line no-await-in-loop
    if ( clip.label ) await syncLabel( clip, clip.label );
  }
};

export default useAudioIdHistory;
