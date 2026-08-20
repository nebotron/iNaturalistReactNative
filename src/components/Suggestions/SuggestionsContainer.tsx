import {
  useNetInfo,
} from "@react-native-community/netinfo";
import { useNavigation, useRoute } from "@react-navigation/native";
import { fetchTaxon } from "api/taxa";
import MediaViewerModal from "components/MediaViewer/MediaViewerModal";
import findIndex from "lodash/findIndex";
import sortBy from "lodash/sortBy";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import ObservationPhoto from "realmModels/ObservationPhoto";
import Photo from "realmModels/Photo";
import TaxonModel from "realmModels/Taxon";
import type { RealmPhoto } from "realmModels/types";
import { subscribeAnimalCropLog } from "sharedHelpers/animalCropLog";
import fetchTaxonAndSave from "sharedHelpers/fetchTaxonAndSave";
import { getAncestorsFromTaxonomyFile } from "sharedHelpers/offlineTaxonomy";
import { cropSignature, onlineSuggestionsQueryKey } from "sharedHelpers/suggestionsQueryKey";
import {
  useCurrentUser,
  useLastScreen,
  useLocationPermission,
  useSuggestions,
} from "sharedHooks";
import useInputImageTracking from "sharedHooks/useInputImageTracking";
import type { TopSuggestionType } from "sharedHooks/useSuggestions/types";
import useStore from "stores/useStore";

import fetchCoarseUserLocation from "../../sharedHelpers/fetchCoarseUserLocation";
import flattenUploadParams from "./helpers/flattenUploadParams";
import useNavigateWithTaxonSelected from "./hooks/useNavigateWithTaxonSelected";
import usePreloadNextObservationSuggestions from "./hooks/usePreloadNextObservationSuggestions";
import Suggestions from "./Suggestions";
import TaxonSearchButton from "./TaxonSearchButton";

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

// Re-framing the photo has to produce a fresh request rather than replay the
// suggestions cached for the previous framing, so the framing is part of the
// key. Built in suggestionsQueryKey because the prefetch helper has to key
// its results identically or the screen won't find them.
const getQueryKey = onlineSuggestionsQueryKey;

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
    // The selected photo was re-framed by hand, so the same photo is scored
    // again over the newly framed region. Only the online request uses the
    // crop, so the offline status (and the results already on screen) stay put
    // until the new suggestions arrive.
    case "RECROP_PHOTO":
      return {
        ...state,
        onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_LOADING,
        scoreImageParams: action.scoreImageParams,
        queryKey: getQueryKey( state.selectedPhotoUri, state.shouldUseEvidenceLocation ),
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
  const currentUser = useCurrentUser( );
  const realm = useRealm( );

  // Observations created locally have no stored user, so they belong to the
  // current user. Only when a user is present and differs is this someone
  // else's observation (e.g. suggesting an ID from ObsDetails), in which case
  // we frame the photo with subject detection for the thumbnail and CV request.
  const belongsToCurrentUser = !currentObservation?.user?.login
    || currentObservation.user.login === currentUser?.login;
  const detectSubject = !belongsToCurrentUser;
  const innerPhotos = ObservationPhoto.mapInnerPhotos( currentObservation );
  // ObservationPhoto.mapObsPhotoUris returns *new* strings with every call,
  // so these values need to be stabilized
  const photoUris = useMemo(
    ( ) => ObservationPhoto.mapObsPhotoUris( currentObservation ),
    [currentObservation],
  );
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
  const [preferOfflineModel, setPreferOfflineModel] = useState( false );
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

  const shouldFetchOnlineSuggestions = !preferOfflineModel
    && ( hasPermissions !== undefined )
    && onlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_LOADING;

  const onlineSuggestionsAttempted
   = onlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_ONLINE_FETCHED
      || onlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_ONLINE_ERROR
      || onlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_ONLINE_SKIPPED;

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
      }
    },
    [],
  );

  const onFetched = useCallback(
    ( { isOnline }: { isOnline: boolean } ) => {
      if ( isOnline ) {
        dispatch( {
          type: "SET_ONLINE_FETCH_STATUS",
          onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_ONLINE_FETCHED,
        } );
      } else {
        dispatch( {
          type: "SET_OFFLINE_FETCH_STATUS",
          offlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_OFFLINE_FETCHED,
        } );
      }
    },
    [],
  );

  const {
    resetTimeout,
    suggestions,
    usingOfflineSuggestions,
    tryOfflineSuggestions,
    urlWillCrashOffline,
  } = useSuggestions( selectedPhotoUri, {
    shouldFetchOnlineSuggestions,
    onFetchError,
    onFetched,
    scoreImageParams,
    queryKey,
    onlineSuggestionsAttempted,
    preferOfflineModel,
  } );

  // Taxa ranked at species level or finer (or of unknown rank) can show a
  // "suggest genus" button; this is decided synchronously from data already
  // in Realm so the button appears immediately instead of after a lookup.
  const genusEligibleTaxonIds = useMemo( ( ) => {
    const allSuggestions = [
      ...( suggestions.topSuggestion
        ? [suggestions.topSuggestion]
        : [] ),
      ...( suggestions.otherSuggestions || [] ),
    ];
    const eligibleIds = new Set<number>( );
    allSuggestions.forEach( suggestion => {
      const taxonId = suggestion.taxon.id;
      const realmTaxon = realm.objectForPrimaryKey( "Taxon", taxonId );
      const rankLevel = suggestion.taxon.rank_level ?? realmTaxon?.rank_level;
      if ( rankLevel == null || rankLevel <= TaxonModel.SPECIES_LEVEL ) {
        eligibleIds.add( taxonId );
      }
    } );
    return eligibleIds;
  }, [suggestions, realm] );

  // The actual genus taxon is only looked up once the user taps the button
  const findGenusForSuggestion = useCallback( async suggestion => {
    const taxonId = suggestion.taxon.id;
    const realmTaxon = realm.objectForPrimaryKey( "Taxon", taxonId );
    const ancestorIds = Array.from( realmTaxon?.ancestor_ids || [] );
    let foundGenusId: number | null = null;

    if ( ancestorIds.length > 0 ) {
      const genusFromRealm = realm.objects( "Taxon" ).filtered(
        "id IN $0 AND rank_level == $1",
        ancestorIds,
        TaxonModel.GENUS_LEVEL,
      )[0];
      if ( genusFromRealm ) foundGenusId = genusFromRealm.id;
    }

    if ( !foundGenusId && ancestorIds.length > 0 ) {
      try {
        const offlineAncestors = await getAncestorsFromTaxonomyFile( ancestorIds );
        const genusAncestor = offlineAncestors.find(
          a => a.rank_level === TaxonModel.GENUS_LEVEL,
        );
        foundGenusId = genusAncestor?.id ?? null;
      } catch { /* Taxonomy file unavailable */ }
    }

    if ( !foundGenusId ) {
      try {
        const taxonWithAncestors = await fetchTaxon( taxonId );
        const genusAncestor = taxonWithAncestors?.ancestors?.find(
          ( a: { rank_level?: number } ) => a.rank_level === TaxonModel.GENUS_LEVEL,
        );
        foundGenusId = genusAncestor?.id ?? null;
      } catch { /* API unavailable */ }
    }

    if ( !foundGenusId ) return null;

    let fullGenusTaxon = realm.objectForPrimaryKey( "Taxon", foundGenusId );
    if ( !fullGenusTaxon ) {
      fullGenusTaxon = await fetchTaxonAndSave( foundGenusId, realm );
    }

    return fullGenusTaxon || null;
  }, [realm] );

  const navigateWithTaxonSelected = useNavigateWithTaxonSelected( { vision: true } );

  const handleSelectGenus = useCallback( async suggestion => {
    const genusTaxon = await findGenusForSuggestion( suggestion );
    if ( genusTaxon ) {
      navigateWithTaxonSelected( genusTaxon );
    }
  }, [findGenusForSuggestion, navigateWithTaxonSelected] );

  const createUploadParams = useCallback( async ( uri: string, showLocation: boolean ) => {
    const newImageParams = await flattenUploadParams( uri, detectSubject );
    if ( showLocation && currentObservation?.latitude ) {
      newImageParams.lat = currentObservation?.latitude;
      newImageParams.lng = currentObservation?.longitude;
    }
    return newImageParams;
  }, [
    currentObservation,
    detectSubject,
  ] );

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
        if ( preferOfflineModel ) {
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
      preferOfflineModel,
    ],
  );

  // Framing the selected photo by hand — pinching it in the media viewer this
  // screen opens, or saving in the crop editor — is a request to identify that
  // region, so the photo is scored again with the new framing.
  const selectedCrop = useSyncExternalStore(
    subscribeAnimalCropLog,
    ( ) => cropSignature( selectedPhotoUri ),
  );
  const scoredFramingRef = useRef( { uri: selectedPhotoUri, crop: selectedCrop } );
  useEffect( ( ) => {
    const previous = scoredFramingRef.current;
    scoredFramingRef.current = { uri: selectedPhotoUri, crop: selectedCrop };
    // A different photo is already scored by whatever selected it.
    if ( previous.uri !== selectedPhotoUri ) return;
    if ( previous.crop === selectedCrop ) return;
    // Only the online request is built from the cropped image.
    if ( !selectedPhotoUri || preferOfflineModel ) return;
    resetTimeout( );
    createUploadParams( selectedPhotoUri, shouldUseEvidenceLocation ).then( params => {
      dispatch( { type: "RECROP_PHOTO", scoreImageParams: params } );
    } );
  }, [
    createUploadParams,
    preferOfflineModel,
    resetTimeout,
    selectedCrop,
    selectedPhotoUri,
    shouldUseEvidenceLocation,
  ] );

  // offline suggestions load first, so loading only depends on them unless
  // offline is unavailable (e.g. a remote photo with no connection)
  const isLoading = tryOfflineSuggestions
    ? offlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_LOADING
    : onlineFetchStatus === FETCH_STATUSES.FETCH_STATUS_LOADING;

  const toggleLocation = useCallback( async ( { showLocation }: { showLocation: boolean } ) => {
    const newImageParams = await createUploadParams( selectedPhotoUri, showLocation );
    resetTimeout( );
    dispatch( {
      type: "TOGGLE_LOCATION",
      shouldUseEvidenceLocation: showLocation,
      scoreImageParams: newImageParams,
    } );
    if ( preferOfflineModel ) {
      dispatch( {
        type: "SET_ONLINE_FETCH_STATUS",
        onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_ONLINE_SKIPPED,
      } );
    }
  }, [
    createUploadParams,
    resetTimeout,
    selectedPhotoUri,
    preferOfflineModel,
  ] );

  const toggleSuggestionsModel = useCallback( ( nextUseOfflineModel: boolean ) => {
    if ( nextUseOfflineModel === preferOfflineModel ) {
      return;
    }
    setPreferOfflineModel( nextUseOfflineModel );
    resetTimeout( );
    dispatch( {
      type: "SWITCH_SUGGESTIONS_MODEL",
      useOfflineModel: nextUseOfflineModel,
    } );
  }, [resetTimeout, preferOfflineModel] );

  const showModelToggle = isConnected && !urlWillCrashOffline;

  const hideLocationToggleButton = usingOfflineSuggestions
    || isLoading
    || showImproveWithLocationButton
    || !isConnected
    || !evidenceHasLocation;

  const setImageParams = useCallback( async ( ) => {
    if ( isConnected === false ) {
      // Skip online suggestions; try offline model for local photos
      dispatch( {
        type: "SET_ONLINE_FETCH_STATUS",
        onlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_ONLINE_SKIPPED,
      } );
      if ( selectedPhotoUri && !selectedPhotoUri.includes( "https://" ) ) {
        const newImageParams = await createUploadParams(
          selectedPhotoUri,
          shouldUseEvidenceLocation,
        );
        dispatch( { type: "SET_UPLOAD_PARAMS", scoreImageParams: newImageParams } );
      } else {
        dispatch( {
          type: "SET_OFFLINE_FETCH_STATUS",
          offlineFetchStatus: FETCH_STATUSES.FETCH_STATUS_OFFLINE_SKIPPED,
        } );
      }
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
      setPreferOfflineModel( false );
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

  // Only set image params when they haven't been set yet. Offline suggestions
  // can finish loading before the focus event fires, so we can't use suggestion
  // state as the signal — scoreImageParams being null is the true indicator.
  const shouldSetImageParams = scoreImageParams === null;

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
    const newImageParams = await flattenUploadParams( selectedPhotoUri, detectSubject );
    newImageParams.lat = userLocation?.latitude;
    newImageParams.lng = userLocation?.longitude;
    dispatch( {
      type: "TOGGLE_LOCATION",
      shouldUseEvidenceLocation: true,
      scoreImageParams: newImageParams,
    } );
  }, [detectSubject, selectedPhotoUri, updateObservationKeys] );

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

  const onCropPhotoUri = useCallback( ( uri: string ) => {
    const photoIdx = photoUris.indexOf( uri );
    if ( photoIdx === -1 ) { return; }
    const photo = innerPhotos[photoIdx] as RealmPhoto;
    if ( !photo ) { return; }
    onCropPhoto( photo );
  }, [innerPhotos, onCropPhoto, photoUris] );

  const handleReorderPhotos = useCallback( ( { data: newPhotoUris }: { data: string[] } ) => {
    const newObsPhotos = observationPhotos.map( obsPhoto => {
      const photoUri = Photo.displayLocalOrRemoteMediumPhoto( obsPhoto.photo );
      const newPosition = findIndex( newPhotoUris, p => p === photoUri );
      return { ...obsPhoto, position: newPosition };
    } );
    const sortedObsPhotos = sortBy( newObsPhotos, obsPhoto => obsPhoto.position );
    updateObservationKeys( { observationPhotos: sortedObsPhotos } );
  }, [observationPhotos, updateObservationKeys] );

  return (
    <>
      <Suggestions
        detectSubject={detectSubject}
        genusEligibleTaxonIds={genusEligibleTaxonIds}
        handleSkip={( ) => navigateWithTaxonSelected( undefined )}
        hideLocationToggleButton={hideLocationToggleButton}
        hideSkip={params?.hideSkip}
        improveWithLocationButtonOnPress={improveWithLocationButtonOnPress}
        isLoading={isLoading}
        shouldUseEvidenceLocation={shouldUseEvidenceLocation}
        onCropPhoto={onCropPhotoUri}
        onPressPhoto={onPressPhoto}
        onReorderPhotos={handleReorderPhotos}
        onSelectGenus={handleSelectGenus}
        onTaxonChosen={navigateWithTaxonSelected}
        photoUris={photoUris}
        selectedPhotoUri={selectedPhotoUri}
        showImproveWithLocationButton={!!showImproveWithLocationButton}
        showModelToggle={showModelToggle}
        suggestions={suggestions}
        toggleLocation={toggleLocation}
        toggleSuggestionsModel={toggleSuggestionsModel}
        useOfflineModel={usingOfflineSuggestions}
      />
      <MediaViewerModal
        autoDetectSubject={detectSubject}
        editable={lastScreen === "ObsEdit" || lastScreen === "Camera"}
        showModal={mediaViewerVisible}
        onClose={( ) => dispatch( {
          type: "TOGGLE_MEDIA_VIEWER",
          mediaViewerVisible: false,
        } )}
        onDeletePhoto={onDeletePhoto}
        onCropPhoto={onCropPhoto}
        onReorderPhotos={handleReorderPhotos}
        initialIndex={photoUris.indexOf( selectedPhotoUri )}
        uri={selectedPhotoUri}
        photos={innerPhotos}
      />
      {renderPermissionsGate( { onPermissionGranted } )}
    </>
  );
};

export default SuggestionsContainer;
