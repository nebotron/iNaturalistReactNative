import {
  useNetInfo,
} from "@react-native-community/netinfo";
import { useNavigation, useRoute } from "@react-navigation/native";
import MediaViewerModal from "components/MediaViewer/MediaViewerModal";
import findIndex from "lodash/findIndex";
import isEqual from "lodash/isEqual";
import sortBy from "lodash/sortBy";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import ObservationPhoto from "realmModels/ObservationPhoto";
import Photo from "realmModels/Photo";
import type { RealmPhoto } from "realmModels/types";
import { getPreviouslyUploadedDevicePhotoUrisSet } from
  "sharedHelpers/duplicateUploadedDevicePhotos";
import { log } from "sharedHelpers/logger";
import {
  useLastScreen,
  useLocationPermission,
  usePerformance,
  useSuggestions,
} from "sharedHooks";
import useDebugMode from "sharedHooks/useDebugMode";
import useInputImageTracking from "sharedHooks/useInputImageTracking";
import {
  internalUseSuggestionsInitialSuggestions,
} from "sharedHooks/useSuggestions/filterSuggestions";
import type { TopSuggestionType } from "sharedHooks/useSuggestions/types";
import useStore from "stores/useStore";

import fetchCoarseUserLocation from "../../sharedHelpers/fetchCoarseUserLocation";
import flattenUploadParams from "./helpers/flattenUploadParams";
import useNavigateWithTaxonSelected from "./hooks/useNavigateWithTaxonSelected";
import usePreloadNextObservationSuggestions from "./hooks/usePreloadNextObservationSuggestions";
import Suggestions from "./Suggestions";
import TaxonSearchButton from "./TaxonSearchButton";

const logger = log.extend( "SuggestionsContainer" );

const { useRealm } = RealmContext;

export enum FETCH_STATUSES {
  FETCH_STATUS_LOADING = "loading",
  FETCH_STATUS_ONLINE_FETCHED = "online-fetched",
  FETCH_STATUS_ONLINE_ERROR = "online-error",
  FETCH_STATUS_OFFLINE_FETCHED = "offline-fetched",
  FETCH_STATUS_OFFLINE_ERROR = "offline-error",
  FETCH_STATUS_OFFLINE_SKIPPED = "offline-skipped",
  FETCH_STATUS_ONLINE_SKIPPED = "online-skipped"
}

const getQueryKey = ( selectedPhotoUri: string, shouldUseEvidenceLocation: boolean ) => [
  "scoreImage",
  selectedPhotoUri,
  { shouldUseEvidenceLocation },
];

interface Suggestion {
  combined_score: number;
  taxon: {
    id: number;
    name: string;
  };
}

interface Suggestions {
  otherSuggestions: Suggestion[];
  topSuggestion: Suggestion | null;
  topSuggestionType: TopSuggestionType;
}

const initialState = {
  onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_LOADING,
  offlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_LOADING,
  scoreImageParams: null,
  mediaViewerVisible: false,
  queryKey: [],
  selectedPhotoUri: null,
  shouldUseEvidenceLocation: false,
};

const reducer = ( state, action ) => {
  switch ( action.type ) {
    case "SET_UPLOAD_PARAMS":
      return {
        ...state,
        scoreImageParams: action.scoreImageParams,
        queryKey: getQueryKey( state.selectedPhotoUri, state.shouldUseEvidenceLocation ),
      };
    case "SELECT_PHOTO":
      return {
        ...state,
        onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_LOADING,
        offlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_LOADING,
        selectedPhotoUri: action.selectedPhotoUri,
        scoreImageParams: action.scoreImageParams,
        queryKey: getQueryKey( action.selectedPhotoUri, state.shouldUseEvidenceLocation ),
      };
    case "SET_ONLINE_FETCH_STATUS":
      return {
        ...state,
        onlineFetchStatus: action.onlineFetchStatus,
      };
    case "SET_OFFLINE_FETCH_STATUS":
      return {
        ...state,
        offlineFetchStatus: action.offlineFetchStatus,
      };
    case "TOGGLE_LOCATION":
      return {
        ...state,
        onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_LOADING,
        offlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_LOADING,
        scoreImageParams: action.scoreImageParams,
        shouldUseEvidenceLocation: action.shouldUseEvidenceLocation,
        queryKey: getQueryKey( state.selectedPhotoUri, action.shouldUseEvidenceLocation ),
      };
    case "SWITCH_SUGGESTIONS_MODEL":
      return {
        ...state,
        onlineFetchStatus: action.useOfflineModel
          ? FETCH_STATUSES.FETCH_STATUS_ONLINE_SKIPPED
          : FETCH_STATUSES.FETCH_STATUS_LOADING,
        offlineFetchStatus: action.useOfflineModel
          ? FETCH_STATUSES.FETCH_STATUS_LOADING
          : FETCH_STATUSES.FETCH_STATUS_OFFLINE_SKIPPED,
      };
    case "TOGGLE_MEDIA_VIEWER":
      return {
        ...state,
        mediaViewerVisible: action.mediaViewerVisible,
      };
    case "RESET_OBSERVATION":
      return {
        ...initialState,
        selectedPhotoUri: action.selectedPhotoUri,
        scoreImageParams: action.scoreImageParams,
        shouldUseEvidenceLocation: action.shouldUseEvidenceLocation,
        queryKey: getQueryKey( action.selectedPhotoUri, action.shouldUseEvidenceLocation ),
      };
    default:
      throw new Error( );
  }
};

const SuggestionsContainer = ( ) => {
  const navigation = useNavigation( );
  const { params } = useRoute( );
  const { isConnected } = useNetInfo( );
  const currentObservation = useStore( state => state.currentObservation );
  const realm = useRealm( );
  const innerPhotos = ObservationPhoto.mapInnerPhotos( currentObservation );
  // ObservationPhoto.mapObsPhotoUris returns *new* strings with every call,
  // so these values need to be stabilized
  const photoUris = useMemo(
    ( ) => ObservationPhoto.mapObsPhotoUris( currentObservation ),
    [currentObservation],
  );
  const duplicatePhotoUris = useMemo( ( ) => {
    const observationPhotos = currentObservation?.observationPhotos || [];
    const excludeUuid = currentObservation?.uuid
      ? [currentObservation.uuid]
      : [];
    const uploadedDevicePhotoUris = getPreviouslyUploadedDevicePhotoUrisSet(
      realm,
      excludeUuid,
    );

    return new Set(
      observationPhotos
        .filter( obsPhoto => (
          obsPhoto.originalDevicePhotoUri
          && uploadedDevicePhotoUris.has( obsPhoto.originalDevicePhotoUri )
        ) )
        .map( obsPhoto => Photo.displayLocalOrRemoteSquarePhoto( obsPhoto.photo ) )
        .filter( ( uri ): uri is string => !!uri ),
    );
  }, [currentObservation, realm] );
  const updateObservationKeys = useStore( state => state.updateObservationKeys );
  const deletePhotoFromObservation = useStore( state => state.deletePhotoFromObservation );
  const { trackImageDeleted } = useInputImageTracking( );

  const observationPhotos = useMemo(
    ( ) => currentObservation?.observationPhotos || [],
    [currentObservation?.observationPhotos],
  );

  const evidenceHasLocation = !!currentObservation?.latitude;

  const [state, dispatch] = useReducer( reducer, {
    ...initialState,
    selectedPhotoUri: photoUris[0],
    shouldUseEvidenceLocation: evidenceHasLocation,
  } );
  const [useOfflineModel, setUseOfflineModel] = useState( false );
  const previousObservationUuidRef = useRef<string | undefined>( currentObservation?.uuid );

  usePreloadNextObservationSuggestions( );

  const {
    hasPermissions,
    renderPermissionsGate,
    requestPermissions,
  } = useLocationPermission( );
  const lastScreen = useLastScreen( );
  const showImproveWithLocationButton = useMemo( ( ) => hasPermissions === false
    && isConnected
    && lastScreen === "Camera", [
    hasPermissions,
    isConnected,
    lastScreen,
  ] );
  const improveWithLocationButtonOnPress = useCallback( ( ) => {
    requestPermissions( );
  }, [requestPermissions] );

  const {
    scoreImageParams,
    onlineFetchStatus,
    offlineFetchStatus,
    mediaViewerVisible,
    queryKey,
    selectedPhotoUri,
    shouldUseEvidenceLocation,
  } = state;

  const shouldFetchOnlineSuggestions = !useOfflineModel
    && ( hasPermissions !== undefined )
    && onlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_LOADING;

  const onlineSuggestionsAttempted
   = onlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_ONLINE_FETCHED
      || onlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_ONLINE_ERROR;

  const onFetchError = useCallback(
    ( { isOnline }: { isOnline: boolean } ) => {
      if ( isOnline ) {
        dispatch( {
          type: "SET_ONLINE_FETCH_STATUS",
          onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_ONLINE_ERROR,
        } );
      } else {
        dispatch( {
          type: "SET_OFFLINE_FETCH_STATUS",
          offlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_OFFLINE_ERROR,
        } );
        // If offline is finished, and online still in loading state it means it never started
        if ( onlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_LOADING ) {
          dispatch( {
            type: "SET_ONLINE_FETCH_STATUS",
            onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_ONLINE_SKIPPED,
          } );
        }
      }
    },
    [onlineFetchStatus],
  );

  const onFetched = useCallback(
    ( { isOnline }: { isOnline: boolean } ) => {
      if ( isOnline ) {
        dispatch( {
          type: "SET_ONLINE_FETCH_STATUS",
          onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_ONLINE_FETCHED,
        } );
        // Currently we start offline only when online has an error, so
        // we can register offline as skipped if online is successful
        dispatch( {
          type: "SET_OFFLINE_FETCH_STATUS",
          offlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_OFFLINE_SKIPPED,
        } );
      } else {
        dispatch( {
          type: "SET_OFFLINE_FETCH_STATUS",
          offlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_OFFLINE_FETCHED,
        } );
        // If offline is finished, and online still in loading state it means it never started
        if ( onlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_LOADING ) {
          dispatch( {
            type: "SET_ONLINE_FETCH_STATUS",
            onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_ONLINE_SKIPPED,
          } );
        }
      }
    },
    [onlineFetchStatus],
  );

  const {
    timedOut,
    resetTimeout,
    onlineSuggestions,
    onlineSuggestionsError,
    onlineSuggestionsUpdatedAt,
    suggestions,
    usingOfflineSuggestions,
    urlWillCrashOffline,
  } = useSuggestions( selectedPhotoUri, {
    shouldFetchOnlineSuggestions,
    onFetchError,
    onFetched,
    scoreImageParams,
    queryKey,
    onlineSuggestionsAttempted,
    preferOfflineModel: useOfflineModel,
  } );

  const createUploadParams = useCallback( async ( uri: string, showLocation: boolean ) => {
    const newImageParams = await flattenUploadParams( uri );
    if ( showLocation && currentObservation?.latitude ) {
      newImageParams.lat = currentObservation?.latitude;
      newImageParams.lng = currentObservation?.longitude;
    }
    return newImageParams;
  }, [
    currentObservation,
  ] );

  const navigateWithTaxonSelected = useNavigateWithTaxonSelected( { vision: true } );

  const onPressPhoto = useCallback(
    async ( uri: string ) => {
      if ( uri === selectedPhotoUri ) {
        dispatch( {
          type: "TOGGLE_MEDIA_VIEWER",
          mediaViewerVisible: true,
        } );
      } else {
        const newImageParams = await createUploadParams( uri, shouldUseEvidenceLocation );
        dispatch( {
          type: "SELECT_PHOTO",
          selectedPhotoUri: uri,
          scoreImageParams: newImageParams,
        } );
        if ( useOfflineModel ) {
          dispatch( {
            type: "SET_ONLINE_FETCH_STATUS",
            onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_ONLINE_SKIPPED,
          } );
        }
      }
    },
    [
      createUploadParams,
      selectedPhotoUri,
      shouldUseEvidenceLocation,
      useOfflineModel,
    ],
  );

  const isLoading = useOfflineModel
    ? offlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_LOADING
    : onlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_LOADING
      || offlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_LOADING;

  const { loadTime } = usePerformance( {
    isLoading,
  } );
  const { isDebug } = useDebugMode();
  useEffect( () => {
    if ( isDebug && loadTime ) {
      logger.info( loadTime );
    }
  }, [isDebug, loadTime] );

  const toggleLocation = useCallback( async ( { showLocation }: { showLocation: boolean } ) => {
    const newImageParams = await createUploadParams( selectedPhotoUri, showLocation );
    resetTimeout( );
    dispatch( {
      type: "TOGGLE_LOCATION",
      shouldUseEvidenceLocation: showLocation,
      scoreImageParams: newImageParams,
    } );
    if ( useOfflineModel ) {
      dispatch( {
        type: "SET_ONLINE_FETCH_STATUS",
        onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_ONLINE_SKIPPED,
      } );
    }
  }, [
    createUploadParams,
    resetTimeout,
    selectedPhotoUri,
    useOfflineModel,
  ] );

  const reloadSuggestions = useCallback( ( ) => {
    // used when offline text is tapped to try to get online
    // suggestions
    if ( !isConnected ) { return; }
    resetTimeout( );
    setUseOfflineModel( false );
    dispatch(
      {
        type: "SET_ONLINE_FETCH_STATUS",
        onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_LOADING,
      },
    );
    dispatch(
      {
        type: "SET_OFFLINE_FETCH_STATUS",
        offlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_LOADING,
      },
    );
  }, [isConnected, resetTimeout] );

  const toggleSuggestionsModel = useCallback( ( nextUseOfflineModel: boolean ) => {
    if ( nextUseOfflineModel === useOfflineModel ) {
      return;
    }
    setUseOfflineModel( nextUseOfflineModel );
    resetTimeout( );
    dispatch( {
      type: "SWITCH_SUGGESTIONS_MODEL",
      useOfflineModel: nextUseOfflineModel,
    } );
  }, [resetTimeout, useOfflineModel] );

  const showModelToggle = isConnected && !urlWillCrashOffline;

  const hideLocationToggleButton = usingOfflineSuggestions
    || isLoading
    || showImproveWithLocationButton
    || !isConnected
    || !evidenceHasLocation;

  const setImageParams = useCallback( async ( ) => {
    if ( isConnected === false ) {
      return;
    }
    const newImageParams = await createUploadParams( selectedPhotoUri, shouldUseEvidenceLocation );
    dispatch( { type: "SET_UPLOAD_PARAMS", scoreImageParams: newImageParams } );
  }, [
    createUploadParams,
    isConnected,
    selectedPhotoUri,
    shouldUseEvidenceLocation,
  ] );

  useEffect( ( ) => {
    const observationUuid = currentObservation?.uuid;
    if ( !observationUuid || previousObservationUuidRef.current === observationUuid ) {
      return;
    }
    const hadPreviousObservation = previousObservationUuidRef.current !== undefined;
    previousObservationUuidRef.current = observationUuid;

    if ( !hadPreviousObservation ) {
      return;
    }

    const resetForNextObservation = async ( ) => {
      const nextPhotoUri = photoUris[0];
      if ( !nextPhotoUri ) {
        return;
      }
      const newImageParams = isConnected === false
        ? null
        : await createUploadParams( nextPhotoUri, evidenceHasLocation );
      setUseOfflineModel( false );
      dispatch( {
        type: "RESET_OBSERVATION",
        selectedPhotoUri: nextPhotoUri,
        scoreImageParams: newImageParams,
        shouldUseEvidenceLocation: evidenceHasLocation,
      } );
    };

    resetForNextObservation( );
  }, [
    createUploadParams,
    currentObservation?.uuid,
    evidenceHasLocation,
    isConnected,
    photoUris,
  ] );

  const headerRight = useCallback( ( ) => <TaxonSearchButton />, [] );

  const shouldSetImageParams = useMemo(
    // TODO: part of MOB-1081, see `internalUseSuggestionsInitialSuggestions`
    // we shouldn't rely on implementation internals to consumer drive state
    () => isEqual( internalUseSuggestionsInitialSuggestions, suggestions ),
    [suggestions],
  );

  useEffect( ( ) => {
    const unsubscribe = navigation.addListener( "focus", ( ) => {
      // resizeImage crashes if trying to resize an https:// photo while there is no internet
      // in this situation, we can skip creating upload parameters since we're loading
      // offline suggestions anyway
      if ( shouldSetImageParams ) {
        setImageParams();
      }
      navigation.setOptions( { headerRight } );
    } );
    return unsubscribe;
  }, [navigation, setImageParams, shouldSetImageParams, headerRight] );

  const onPermissionGranted = useCallback( async ( ) => {
    const userLocation = await fetchCoarseUserLocation( );
    updateObservationKeys( userLocation );
    const newImageParams = await flattenUploadParams( selectedPhotoUri );
    newImageParams.lat = userLocation?.latitude;
    newImageParams.lng = userLocation?.longitude;
    dispatch( {
      type: "TOGGLE_LOCATION",
      shouldUseEvidenceLocation: true,
      scoreImageParams: newImageParams,
    } );
  }, [selectedPhotoUri, updateObservationKeys] );

  const afterMediaDeleted = useCallback( ( ) => {
    const freshObservation = useStore.getState( ).currentObservation;
    const freshPhotoUris = ObservationPhoto.mapObsPhotoUris( freshObservation );
    if ( freshPhotoUris.length === 0 ) {
      dispatch( { type: "TOGGLE_MEDIA_VIEWER", mediaViewerVisible: false } );
      navigation.goBack( );
      return;
    }
    const newUri = freshPhotoUris[freshPhotoUris.length - 1];
    createUploadParams( newUri, shouldUseEvidenceLocation ).then( params => {
      dispatch( {
        type: "SELECT_PHOTO",
        selectedPhotoUri: newUri,
        scoreImageParams: params,
      } );
    } );
  }, [createUploadParams, navigation, shouldUseEvidenceLocation] );

  const onDeletePhoto = useCallback( async ( uriToDelete: string ) => {
    await ObservationPhoto.deletePhoto( uriToDelete, currentObservation );
    deletePhotoFromObservation( uriToDelete );
    trackImageDeleted( uriToDelete );
    afterMediaDeleted( );
  }, [afterMediaDeleted, currentObservation, deletePhotoFromObservation, trackImageDeleted] );

  const onCropPhoto = useCallback( ( photo: RealmPhoto ) => {
    const cropUri = Photo.displayCropSourcePhoto( photo );
    if ( !cropUri ) { return; }

    const obsPhoto = observationPhotos.find( candidate => {
      const candidateUri = Photo.displayCropSourcePhoto( candidate.photo );
      const candidateLargeUri = Photo.displayLocalOrRemoteLargePhoto( candidate.photo );
      const candidateSquareUri = Photo.displayLocalOrRemoteSquarePhoto( candidate.photo );
      return candidateUri === cropUri
        || candidateLargeUri === Photo.displayLocalOrRemoteLargePhoto( photo )
        || candidateSquareUri === Photo.displayLocalOrRemoteSquarePhoto( photo );
    } );
    if ( !obsPhoto ) { return; }

    dispatch( { type: "TOGGLE_MEDIA_VIEWER", mediaViewerVisible: false } );
    navigation.navigate( "ImageCropEditor", {
      imageUri: cropUri,
      context: "observationEdit",
      observationPhotoUuid: obsPhoto.uuid,
      onCropSaved: ( ) => {
        const freshObservation = useStore.getState( ).currentObservation;
        const freshPhotoUris = ObservationPhoto.mapObsPhotoUris( freshObservation );
        const photoIdx = ( currentObservation?.observationPhotos || [] )
          .findIndex( op => op.uuid === obsPhoto.uuid );
        const newUri = freshPhotoUris[photoIdx] ?? freshPhotoUris[0];
        if ( newUri ) {
          createUploadParams( newUri, shouldUseEvidenceLocation ).then( params => {
            dispatch( {
              type: "SELECT_PHOTO",
              selectedPhotoUri: newUri,
              scoreImageParams: params,
            } );
          } );
        }
      },
    } );
  }, [
    createUploadParams,
    currentObservation,
    navigation,
    observationPhotos,
    shouldUseEvidenceLocation,
  ] );

  const handleReorderPhotos = useCallback( ( { data: newPhotoUris }: { data: string[] } ) => {
    const newObsPhotos = observationPhotos.map( obsPhoto => {
      const photoUri = Photo.displayLocalOrRemoteMediumPhoto( obsPhoto.photo );
      const newPosition = findIndex( newPhotoUris, p => p === photoUri );
      return { ...obsPhoto, position: newPosition };
    } );
    const sortedObsPhotos = sortBy( newObsPhotos, obsPhoto => obsPhoto.position );
    updateObservationKeys( { observationPhotos: sortedObsPhotos } );
  }, [observationPhotos, updateObservationKeys] );

  const debugData = {
    timedOut,
    onlineFetchStatus,
    onlineSuggestions,
    onlineSuggestionsError,
    onlineSuggestionsUpdatedAt,
    selectedPhotoUri,
    shouldUseEvidenceLocation,
    topSuggestionType: suggestions?.topSuggestionType,
    offlineFetchStatus,
    usingOfflineSuggestions,
    suggestions,
  };

  return (
    <>
      <Suggestions
        debugData={debugData}
        handleSkip={( ) => navigateWithTaxonSelected( undefined )}
        hideLocationToggleButton={hideLocationToggleButton}
        hideSkip={params?.hideSkip}
        improveWithLocationButtonOnPress={improveWithLocationButtonOnPress}
        isLoading={isLoading}
        shouldUseEvidenceLocation={shouldUseEvidenceLocation}
        onPressPhoto={onPressPhoto}
        onReorderPhotos={handleReorderPhotos}
        onTaxonChosen={navigateWithTaxonSelected}
        duplicatePhotoUris={duplicatePhotoUris}
        photoUris={photoUris}
        reloadSuggestions={reloadSuggestions}
        selectedPhotoUri={selectedPhotoUri}
        showImproveWithLocationButton={!!showImproveWithLocationButton}
        showModelToggle={showModelToggle}
        suggestions={suggestions}
        toggleLocation={toggleLocation}
        toggleSuggestionsModel={toggleSuggestionsModel}
        urlWillCrashOffline={urlWillCrashOffline}
        useOfflineModel={useOfflineModel}
        usingOfflineSuggestions={usingOfflineSuggestions}
      />
      <MediaViewerModal
        editable
        showModal={mediaViewerVisible}
        onClose={( ) => dispatch( {
          type: "TOGGLE_MEDIA_VIEWER",
          mediaViewerVisible: false,
        } )}
        onDeletePhoto={onDeletePhoto}
        onCropPhoto={onCropPhoto}
        onReorderPhotos={handleReorderPhotos}
        uri={selectedPhotoUri}
        photos={innerPhotos}
      />
      {renderPermissionsGate( { onPermissionGranted } )}
    </>
  );
};

export default SuggestionsContainer;
