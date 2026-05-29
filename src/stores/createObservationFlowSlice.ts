import { Realm } from "@realm/react";
import type { ApiSuggestion } from "api/types";
import cloneDeep from "lodash/cloneDeep";
import isEmpty from "lodash/isEmpty";
import pull from "lodash/pull";
import remove from "lodash/remove";
import Photo from "realmModels/Photo";
import Sound from "realmModels/Sound";
import type { RealmObservation, RealmObservationPojo } from "realmModels/types";
import {
  deleteDevicePhotosRemovedDuringObservationPrep,
  resolveDevicePhotoUriForRemovedObservationPhoto,
} from "sharedHelpers/deleteDevicePhotosDuringObservationPrep";
import {
  normalizeDevicePhotoUri,
  registerImportedPhotoDeviceUriMappings,
} from "sharedHelpers/getOriginalDevicePhotoUri";
import type { BackupMapping } from "sharedHelpers/rollbackPhotos";
import type { StateCreator } from "zustand";

interface RollbackSnapshot {
  observations: RealmObservationPojo[];
  currentObservationIndex: number;
  cameraUris: string[];
  cameraRollUris: string[];
  photoLibraryUris: string[];
  originalDevicePhotoUris: string[];
  removedOriginalDevicePhotoUris: string[];
  evidenceToAdd: string[];
  newPhotoUris: string[];
  unsavedChanges: boolean;
}

interface GroupedPhoto {
  photos: string[];
}

export interface LastLocationPickerState {
  region: {
    latitude: number;
    longitude: number;
    latitudeDelta: number;
    longitudeDelta: number;
  };
  accuracy: number;
  locationName: string;
}

interface CameraStateOptions {
  evidenceToAdd?: string[];
  cameraUris?: string[];
}

interface PhotoImporterOptions {
  photoLibraryUris?: string[];
  savingPhoto?: boolean;
  evidenceToAdd?: string[];
  groupedPhotos?: GroupedPhoto[];
  observations?: RealmObservationPojo[];
  firstObservationDefaults?: Partial<RealmObservationPojo>;
}

interface ObservationFlowState {
  aICameraSuggestion: ApiSuggestion | null;
  cameraRollUris: string[];
  currentObservation: RealmObservationPojo | null;
  currentObservationIndex: number;
  evidenceToAdd: string[];
  photoLibraryUris: string[];
  originalDevicePhotoUris: string[];
  removedOriginalDevicePhotoUris: string[];
  groupedPhotos: GroupedPhoto[];
  observations: RealmObservationPojo[];
  observationMarkedAsViewedAt: Date | null;
  cameraUris: string[];
  savingPhoto: boolean;
  savedOrUploadedMultiObsFlow: boolean;
  unsavedChanges: boolean;
  totalSavedObservations: number;
  sentinelFileName: string | null;
  newPhotoUris: string[];
  rollbackSnapshot: RollbackSnapshot | null;
  backupMappings: BackupMapping[];
  firstObservationDefaults?: Partial<RealmObservationPojo>;
  lastLocationPickerState: LastLocationPickerState | null;
}

interface ObservationFlowActions {
  deletePhotoFromObservation: ( uri: string ) => void;
  deleteSoundFromObservation: ( uri: string ) => void;
  resetObservationFlowSlice: ( ) => void;
  addCameraRollUris: ( uris: string[] ) => void;
  addOriginalDevicePhotoUris: ( uris: string[] ) => void;
  setSavingPhoto: ( saving: boolean ) => void;
  setCameraState: ( options: CameraStateOptions ) => void;
  setCurrentObservationIndex: ( index: number ) => void;
  removeObservationFromMultiObsFlowAtIndex: ( removedIndex: number ) => void;
  setGroupedPhotos: ( photos: GroupedPhoto[] ) => void;
  setObservationMarkedAsViewedAt: ( date: Date | null ) => void;
  setObservations: ( updatedObservations: RealmObservationPojo[] ) => void;
  setPhotoImporterState: ( options: PhotoImporterOptions ) => void;
  setSavedOrUploadedMultiObsFlow: ( ) => void;
  updateObservations: ( updatedObservations: RealmObservationPojo[] ) => void;
  updateObservationKeys: ( keysAndValues: Partial<RealmObservationPojo> ) => void;
  getCurrentObservation: ( ) => RealmObservationPojo | null;
  prepareObsEdit: ( observation: RealmObservationPojo ) => void;
  prepareCamera: ( ) => void;
  incrementTotalSavedObservations: ( ) => void;
  setSentinelFileName: ( sentinelFileName: string | null ) => void;
  setNewPhotoUris: ( newPhotoUris: string[] ) => void;
  setAICameraSuggestion: ( suggestion: ApiSuggestion | null ) => void;
  restoreRollbackSnapshot: ( ) => void;
  setBackupMappings: ( mappings: BackupMapping[] ) => void;
  clearRollbackSnapshot: ( ) => void;
  setRollbackSnapshot: ( ) => void;
  setLastLocationPickerState: ( state: LastLocationPickerState | null ) => void;
}

type ObservationFlowSlice = ObservationFlowState & ObservationFlowActions;

const DEFAULT_STATE: ObservationFlowState = {
  aICameraSuggestion: null,
  cameraRollUris: [],
  currentObservation: null,
  currentObservationIndex: 0,
  evidenceToAdd: [],
  photoLibraryUris: [],
  originalDevicePhotoUris: [],
  removedOriginalDevicePhotoUris: [],
  groupedPhotos: [],
  observations: [],
  // Track when any obs was last marked as viewed so we know when to update
  // the notifications indicator
  observationMarkedAsViewedAt: null,
  // Array of URIs of photos taken in the camera. These should be fully
  // processed, including rotation or any other transformations. It might
  // also include URIs of other photos that need to be visible as previews in
  // the camera
  cameraUris: [],
  savingPhoto: false,
  savedOrUploadedMultiObsFlow: false,
  unsavedChanges: false,
  totalSavedObservations: 0,
  sentinelFileName: null,
  newPhotoUris: [],
  rollbackSnapshot: null,
  backupMappings: [],
  lastLocationPickerState: null,
};

const removeObsSoundFromObservation = (
  currentObservation: RealmObservationPojo | null,
  uri: string,
): RealmObservationPojo[] => {
  if ( isEmpty( currentObservation ) ) { return []; }
  const updatedObservation = currentObservation;
  const obsSounds = Array.from( currentObservation?.observationSounds || [] );
  if ( obsSounds.length > 0 ) {
    remove(
      obsSounds,
      obsSound => (
        obsSound.sound.file_url === uri
        || Sound.getLocalSoundUri( obsSound.sound.file_url ) === uri
      ),
    );
    updatedObservation.observationSounds = obsSounds;
    return [updatedObservation];
  }
  return [currentObservation];
};

const observationToJSON = (
  observation: RealmObservationPojo | RealmObservation | null,
): RealmObservationPojo | null => ( observation instanceof Realm.Object
  ? observation.toJSON( ) as unknown as RealmObservationPojo
  : observation );

/** Keeps index in range when the observations array is replaced with a shorter list */
const clampObservationIndex = ( index: number, length: number ): number => {
  if ( length <= 0 ) { return 0; }
  return Math.min( Math.max( index, 0 ), length - 1 );
};

const keysAndValuesToJSON = (
  keysAndValues: Partial<RealmObservationPojo>,
): Partial<RealmObservationPojo> => {
  const result: Record<string, unknown> = {};
  Object.keys( keysAndValues ).forEach( key => {
    const value = keysAndValues[key as keyof RealmObservationPojo];
    result[key] = value instanceof Realm.Object
      ? value.toJSON( )
      : value;
  } );
  return result as Partial<RealmObservationPojo>;
};

const updateObservationKeysWithState = (
  keysAndValues: Partial<RealmObservationPojo>,
  state: ObservationFlowState,
) => {
  const {
    observations,
    currentObservation,
    currentObservationIndex,
  } = state;
  const updatedObservations = observations;
  const updatedObservation = {
    ...observationToJSON( currentObservation ),
    ...keysAndValuesToJSON( keysAndValues ),
  } as RealmObservationPojo;
  updatedObservations[currentObservationIndex] = updatedObservation;
  return updatedObservations;
};

const createObservationFlowSlice: StateCreator<ObservationFlowSlice> = ( set, get ) => ( {
  ...DEFAULT_STATE,
  deletePhotoFromObservation: ( uri: string ) => {
    const state = get( );
    const observation = state.observations[state.currentObservationIndex];
    const isNewObs = observation && !observation._created_at;
    let deviceUriToDelete: string | null = null;

    set( currentState => {
      const newObservations = [...currentState.observations];
      let newObservation: RealmObservationPojo | null = null;
      if ( newObservations.length > 0 ) {
        newObservation = newObservations[currentState.currentObservationIndex];
        const index = newObservation.observationPhotos.findIndex(
          op => observationPhotoMatchesUri( op, uri ),
        );
        if ( index > -1 ) {
          const removedPhoto = newObservation.observationPhotos[index];
          deviceUriToDelete = normalizeDevicePhotoUri(
            resolveDevicePhotoUriForRemovedObservationPhoto(
              removedPhoto,
              newObservation.observationPhotos,
              index,
              currentState.cameraRollUris,
              currentState.importedPhotoDeviceUriByLocalUri,
            ),
          );
          newObservation = {
            ...newObservation,
            observationPhotos: [
              ...newObservation.observationPhotos.slice( 0, index ),
              ...newObservation.observationPhotos.slice( index + 1 ),
            ],
          };
          newObservations[currentState.currentObservationIndex] = newObservation;
        }
      }

      let { cameraRollUris } = currentState;
      let { importedPhotoDeviceUriByLocalUri } = currentState;
      if ( deviceUriToDelete ) {
        const cameraRollIndex = cameraRollUris.findIndex(
          rollUri => normalizeDevicePhotoUri( rollUri ) === deviceUriToDelete,
        );
        if ( cameraRollIndex > -1 ) {
          cameraRollUris = [
            ...cameraRollUris.slice( 0, cameraRollIndex ),
            ...cameraRollUris.slice( cameraRollIndex + 1 ),
          ];
        }

        importedPhotoDeviceUriByLocalUri = Object.fromEntries(
          Object.entries( currentState.importedPhotoDeviceUriByLocalUri )
            .filter( ( [_, mappedUri] ) => (
              normalizeDevicePhotoUri( mappedUri ) !== deviceUriToDelete
            ) ),
        );
      }

      return {
        cameraUris: [...pull( currentState.cameraUris, uri )],
        cameraRollUris,
        evidenceToAdd: [...pull( currentState.evidenceToAdd, uri )],
        observations: newObservations,
        currentObservation: newObservation
          ? observationToJSON( newObservation )
          : null,
        importedPhotoDeviceUriByLocalUri,
        originalDevicePhotoUris: deviceUriToDelete
          ? currentState.originalDevicePhotoUris.filter(
            originalUri => normalizeDevicePhotoUri( originalUri ) !== deviceUriToDelete,
          )
          : currentState.originalDevicePhotoUris,
        unsavedChanges: true,
      };
    } );

    if ( isNewObs && deviceUriToDelete ) {
      deleteDevicePhotosRemovedDuringObservationPrep( [deviceUriToDelete] );
    }
  },
  deleteSoundFromObservation: ( uri: string ) => set( state => {
    const newObservations = removeObsSoundFromObservation(
      state.observations[state.currentObservationIndex],
      uri,
    );
    const newObservation = newObservations[state.currentObservationIndex];
    return {
      observations: newObservations,
      currentObservation: newObservation,
      unsavedChanges: true,
    };
  } ),
  resetObservationFlowSlice: ( ) => set( DEFAULT_STATE ),
  setLastLocationPickerState: ( lastLocationPickerState: LastLocationPickerState | null ) => set( {
    lastLocationPickerState,
  } ),
  addCameraRollUris: ( uris: string[] ) => set( state => {
    const savedUris = state.cameraRollUris;
    // A placeholder uri means we don't know the real URI, probably b/c we
    // only had write permission so we were able to write the photo to the
    // camera roll but not read anything about it. Keep in mind this is just
    // a hack around a bug in CameraRoll. See
    // patches/@react-native-camera-roll+camera-roll+7.5.2.patch
    uris.forEach( uri => {
      if ( uri && !uri.match( /placeholder/ ) ) savedUris.push( uri );
    } );

    return ( {
      cameraRollUris: savedUris,
      savingPhoto: false,
    } );
  } ),
  addOriginalDevicePhotoUris: ( uris: string[] ) => set( state => {
    const originalDevicePhotoUris = [...state.originalDevicePhotoUris];
    uris.forEach( uri => {
      if ( uri && !originalDevicePhotoUris.includes( uri ) ) {
        originalDevicePhotoUris.push( uri );
      }
    } );

    return { originalDevicePhotoUris };
  } ),
  setSavingPhoto: ( saving: boolean ) => set( { savingPhoto: saving } ),
  setCameraState: ( options: CameraStateOptions ) => set( state => ( {
    evidenceToAdd: options?.evidenceToAdd || state.evidenceToAdd,
    cameraUris:
      options?.cameraUris || state.cameraUris,
  } ) ),
  setCurrentObservationIndex: ( index: number ) => set( state => {
    const currentObservationIndex = clampObservationIndex(
      index,
      state.observations.length,
    );
    return {
      currentObservationIndex,
      currentObservation: state.observations.length > 0
        ? observationToJSON( state.observations[currentObservationIndex] )
        : null,
    };
  } ),
  removeObservationFromMultiObsFlowAtIndex: ( removedIndex: number ) => set( state => {
    if ( removedIndex < 0 || removedIndex >= state.observations.length ) {
      return {};
    }
    const observations = state.observations.filter(
      ( _obs, index ) => index !== removedIndex,
    );
    const wasLast = removedIndex === state.observations.length - 1;
    let { currentObservationIndex } = state;

    if ( removedIndex < currentObservationIndex ) {
      currentObservationIndex -= 1;
    } else if ( removedIndex === currentObservationIndex ) {
      currentObservationIndex = wasLast
        ? removedIndex - 1
        : removedIndex;
    }
    currentObservationIndex = clampObservationIndex(
      currentObservationIndex,
      observations.length,
    );

    return {
      observations,
      currentObservationIndex,
      currentObservation: observations.length > 0
        ? observationToJSON( observations[currentObservationIndex] )
        : null,
    };
  } ),
  setGroupedPhotos: ( photos: GroupedPhoto[] ) => set( {
    groupedPhotos: photos,
  } ),
  setObservationMarkedAsViewedAt: ( date: Date | null ) => set( {
    observationMarkedAsViewedAt: date,
  } ),
  setObservations: (
    updatedObservations: RealmObservationPojo[],
  ) => set( state => {
    const observations = updatedObservations
      .map( observationToJSON )
      .filter( Boolean ) as RealmObservationPojo[];
    const currentObservationIndex = clampObservationIndex(
      state.currentObservationIndex,
      observations.length,
    );
    return {
      observations,
      currentObservationIndex,
      currentObservation: observations.length > 0
        ? observationToJSON( observations[currentObservationIndex] )
        : null,
    };
  } ),
  setPhotoImporterState: ( options: PhotoImporterOptions ) => set( state => ( {
    photoLibraryUris: options?.photoLibraryUris || state.photoLibraryUris,
    savingPhoto: options?.savingPhoto || state.savingPhoto,
    evidenceToAdd: options?.evidenceToAdd || state.evidenceToAdd,
    groupedPhotos: options?.groupedPhotos || state.groupedPhotos,
    observations: options?.observations || state.observations,
    currentObservation: observationToJSON(
      options?.observations?.[state.currentObservationIndex]
      || state.observations?.[state.currentObservationIndex],
    ),
    firstObservationDefaults: options?.firstObservationDefaults,
  } ) ),
  setSavedOrUploadedMultiObsFlow: ( ) => set( {
    savedOrUploadedMultiObsFlow: true,
  } ),
  updateObservations: (
    updatedObservations: RealmObservationPojo[],
  ) => set( state => {
    const observations = updatedObservations
      .map( observationToJSON )
      .filter( Boolean ) as RealmObservationPojo[];
    const currentObservationIndex = clampObservationIndex(
      state.currentObservationIndex,
      observations.length,
    );
    return {
      observations,
      currentObservationIndex,
      currentObservation: observations.length > 0
        ? observationToJSON( observations[currentObservationIndex] )
        : null,
    };
  } ),
  updateObservationKeys: ( keysAndValues, setUnsavedChanges = true ) => set( state => ( {
    observations: updateObservationKeysWithState( keysAndValues, state ),
    currentObservation:
      updateObservationKeysWithState( keysAndValues, state )[state.currentObservationIndex],
    unsavedChanges: !!setUnsavedChanges,
  } ) ),
  // For situations where a consumer needs access to this part of state
  // immediately, not after a couple render cycles
  getCurrentObservation: ( ) => get( ).currentObservation,
  // Prepare state for showing ObsEdit for a single observation
  prepareObsEdit: ( observation: RealmObservationPojo ) => {
    get( ).resetObservationFlowSlice( );
    get( ).updateObservations( [observation] );
  },
  prepareCamera: () => {
    const existingPhotoUris = get( )
      .currentObservation
      ?.observationPhotos
      ?.map( op => op.photo.url || Photo.getLocalPhotoUri( op.photo.localFilePath ) )
      .filter( ( uri ): uri is string => uri != null ) || [];
    return set( { evidenceToAdd: [], cameraUris: existingPhotoUris } );
  },
  incrementTotalSavedObservations: ( ) => set( state => {
    const {
      totalSavedObservations: existingTotalSavedObservations,
    } = state;

    return ( {
      totalSavedObservations: existingTotalSavedObservations + 1,
    } );
  } ),
  setSentinelFileName: ( sentinelFileName: string | null ) => set( {
    sentinelFileName,
  } ),
  setNewPhotoUris: ( newPhotoUris: string[] ) => set( {
    newPhotoUris,
  } ),
  setAICameraSuggestion: ( suggestion: ApiSuggestion | null ) => set( {
    aICameraSuggestion: suggestion,
  } ),
  restoreRollbackSnapshot: ( ) => set( state => {
    const snapshot = state.rollbackSnapshot;
    if ( !snapshot ) return {};
    return {
      observations: snapshot.observations,
      currentObservation: snapshot.observations[snapshot.currentObservationIndex],
      currentObservationIndex: snapshot.currentObservationIndex,
      cameraUris: snapshot.cameraUris,
      cameraRollUris: snapshot.cameraRollUris,
      photoLibraryUris: snapshot.photoLibraryUris,
      originalDevicePhotoUris: snapshot.originalDevicePhotoUris,
      removedOriginalDevicePhotoUris: snapshot.removedOriginalDevicePhotoUris,
      evidenceToAdd: snapshot.evidenceToAdd,
      newPhotoUris: snapshot.newPhotoUris,
      unsavedChanges: snapshot.unsavedChanges,
      rollbackSnapshot: null,
      backupMappings: [],
    };
  } ),
  setBackupMappings: ( mappings: BackupMapping[] ) => set( { backupMappings: mappings } ),
  clearRollbackSnapshot: ( ) => set( { rollbackSnapshot: null, backupMappings: [] } ),
  setRollbackSnapshot: ( ) => set( state => ( {
    rollbackSnapshot: {
      observations: cloneDeep( state.observations ),
      currentObservationIndex: state.currentObservationIndex,
      cameraUris: [...state.cameraUris],
      cameraRollUris: [...state.cameraRollUris],
      photoLibraryUris: [...state.photoLibraryUris],
      originalDevicePhotoUris: [...state.originalDevicePhotoUris],
      removedOriginalDevicePhotoUris: [...state.removedOriginalDevicePhotoUris],
      evidenceToAdd: [...state.evidenceToAdd],
      newPhotoUris: [...state.newPhotoUris],
      unsavedChanges: state.unsavedChanges,
    },
  } ) ),
} );

export const selectCanRollbackToMatch = ( state: ObservationFlowSlice ): boolean => (
  state.rollbackSnapshot !== null
  && state.rollbackSnapshot.observations[state.rollbackSnapshot.currentObservationIndex]?.uuid
    === state.currentObservation?.uuid
);

export default createObservationFlowSlice;
