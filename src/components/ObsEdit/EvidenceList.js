// @flow

import { useNavigation } from "@react-navigation/native";
import deleteRemoteObservationSound from "api/observationSounds";
import classnames from "classnames";
import MediaViewerModal from "components/MediaViewer/MediaViewerModal";
import { ActivityIndicator, INatIcon, INatIconButton } from "components/SharedComponents";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import { Image, Pressable, View } from "components/styledComponents";
import findIndex from "lodash/findIndex";
import sortBy from "lodash/sortBy";
import { RealmContext } from "providers/contexts";
import type { Node } from "react";
import React, {
  useCallback, useMemo, useState,
} from "react";
import { Alert } from "react-native";
import DraggableFlatList, { ScaleDecorator } from "react-native-draggable-flatlist";
import ObservationPhoto from "realmModels/ObservationPhoto";
import ObservationSound from "realmModels/ObservationSound";
import Photo from "realmModels/Photo";
import { getPreviouslyUploadedDevicePhotoUrisSet } from
  "sharedHelpers/duplicateUploadedDevicePhotos";
import { log } from "sharedHelpers/logger";
import { useAuthenticatedMutation } from "sharedHooks";
import useInputImageTracking from "sharedHooks/useInputImageTracking";
import useTranslation from "sharedHooks/useTranslation";
import useStore from "stores/useStore";
import colors from "styles/tailwindColors";

const { useRealm } = RealmContext;
const logger = log.extend( "EvidenceList" );

type Props = {
  handleAddEvidence?: Function,
  observationSounds?: {
    id?: number,
    sound: {
      file_url: string,
    },
    uuid: string
  }[]
}

const EvidenceList = ( {
  handleAddEvidence,
  observationSounds = [],
}: Props ): Node => {
  const navigation = useNavigation( );
  const currentObservation = useStore( state => state.currentObservation );

  const deletePhotoFromObservation = useStore( state => state.deletePhotoFromObservation );
  const deleteSoundFromObservation = useStore( state => state.deleteSoundFromObservation );
  const updateObservationKeys = useStore( state => state.updateObservationKeys );
  const savingPhoto = useStore( state => state.savingPhoto );
  const realm = useRealm( );
  const { t } = useTranslation( );
  const { trackImageDeleted } = useInputImageTracking( );
  const [selectedMediaUri, setSelectedMediaUri]: [string | null, Function] = useState( null );
  const [deleting, setDeleting] = useState( false );
  const imageClass = "h-16 w-16 justify-center mx-1.5 rounded-lg";

  const observationPhotos = useMemo(
    ( ) => currentObservation?.observationPhotos || [],
    [currentObservation?.observationPhotos],
  );

  const photoUris = useMemo(
    ( ) => observationPhotos
      .map( obsPhoto => Photo.displayLocalOrRemoteSquarePhoto( obsPhoto.photo ) )
      .filter( Boolean ),
    [observationPhotos],
  );

  const duplicatePhotoUris = useMemo( ( ) => {
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
        .filter( Boolean ),
    );
  }, [currentObservation?.uuid, observationPhotos, realm] );
  const mediaUris = useMemo( ( ) => ( [
    ...photoUris,
    ...observationSounds.map( obsSound => obsSound.sound.file_url ),
  ] ), [photoUris, observationSounds] );

  const handleDragAndDrop = useCallback( ( { data: newPhotoPositions } ) => {
    const newObsPhotos = observationPhotos.map( ( obsPhoto => {
      const { photo } = obsPhoto;
      const photoUri = Photo.displayLocalOrRemoteSquarePhoto( photo );
      const newPosition = findIndex( newPhotoPositions, p => p === photoUri );
      obsPhoto.position = newPosition;
      return obsPhoto;
    } ) );
    const sortedObsPhotos = sortBy( newObsPhotos, obsPhoto => obsPhoto.position );
    updateObservationKeys( {
      observationPhotos: sortedObsPhotos,
    } );
  }, [
    observationPhotos,
    updateObservationKeys,
  ] );

  const renderPhoto = useCallback(
    ( { item: obsPhotoUri, _getIndex, drag } ) => (
      <ScaleDecorator>
        <Pressable
          onLongPress={drag}
          accessibilityRole="button"
          accessibilityLabel={t( "Select-or-drag-media" )}
          onPress={( ) => {
            setSelectedMediaUri( obsPhotoUri );
          }}
          className={classnames( imageClass )}
          testID={`EvidenceList.${obsPhotoUri}`}
        >
          <View className="rounded-lg overflow-hidden relative">
            <Image
              source={{ uri: obsPhotoUri }}
              testID="ObsEdit.photo"
              className="w-fit h-full flex items-center justify-center"
              accessibilityIgnoresInvertColors
            />
            {duplicatePhotoUris.has( obsPhotoUri ) && (
              <DuplicateUploadBadge
                accessibilityLabel={t( "Duplicate-photo-indicator" )}
                className="absolute top-1 left-1 z-10"
                size={14}
                testID={`EvidenceList.duplicate.${obsPhotoUri}`}
              />
            )}
          </View>
        </Pressable>
      </ScaleDecorator>
    ),
    [duplicatePhotoUris, setSelectedMediaUri, t],
  );

  const renderFooter = useMemo( ( ) => (
    <View className="flex-1 flex-row">
      <View className="flex-row">
        { observationSounds.map( obsSound => (
          <View
            key={`sound-${obsSound.uuid}`}
            className={classnames( imageClass, "border-2" )}
          >
            <INatIconButton
              icon="sound-outline"
              onPress={( ) => setSelectedMediaUri( obsSound.sound.file_url )}
              accessibilityLabel="Sound"
              width={60}
              height={60}
              size={26}
            />
          </View>
        ) ) }
      </View>
      { savingPhoto && (
        <View className={classnames( imageClass )} testID="EvidenceList.saving">
          <View className="border-2 rounded-lg overflow-hidden w-fit h-full justify-center">
            <ActivityIndicator size={26} />
          </View>
        </View>
      ) }
    </View>
  ), [
    observationSounds,
    savingPhoto,
    setSelectedMediaUri,
  ] );

  const renderHeader = useMemo( ( ) => (
    <Pressable
      accessibilityLabel={t( "Add-evidence" )}
      accessibilityRole="button"
      onPress={handleAddEvidence}
      className={
        `${imageClass} border border-[2px] border-darkGray items-center justify-center ml-6`
      }
      testID="EvidenceList.add"
    >
      <INatIcon name="plus-bold" size={27} color={colors.darkGray} />
    </Pressable>
  ), [handleAddEvidence, t] );

  const afterMediaDeleted = useCallback( deletedUri => {
    // If there was was only one item and it was deleted, close the modal by
    // nullifying the selected media URI. Otherwise, choose the last
    // remaining item.
    //
    // A synced photo with a local file copy is identified by its local file
    // URI (what the delete button passes), but mediaUris stores the remote URL
    // for such photos. Normalize to the display URI before filtering.
    const matchedObsPhoto = observationPhotos.find( op => {
      const localUri = Photo.getLocalPhotoUri( op.photo?.localFilePath );
      return localUri === deletedUri || op.photo?.url === deletedUri;
    } );
    const effectiveDeletedUri = matchedObsPhoto
      ? Photo.displayLocalOrRemoteSquarePhoto( matchedObsPhoto.photo )
      : deletedUri;
    const remainingMediaUris = mediaUris.filter( uri => uri !== effectiveDeletedUri );
    if ( remainingMediaUris.length === 0 ) {
      setSelectedMediaUri( null );
    } else {
      setSelectedMediaUri( remainingMediaUris[remainingMediaUris.length - 1] );
    }
    setDeleting( false );
  }, [mediaUris, observationPhotos, setSelectedMediaUri] );

  const { mutate: deleteObservationSoundMutate } = useAuthenticatedMutation(
    ( params, optsWithAuth ) => deleteRemoteObservationSound( params, optsWithAuth ),
  );

  const onDeletePhoto = useCallback( async uriToDelete => {
    await ObservationPhoto.deletePhoto( uriToDelete, currentObservation );
    deletePhotoFromObservation( uriToDelete );
    trackImageDeleted( uriToDelete );
    afterMediaDeleted( uriToDelete );
  }, [afterMediaDeleted, currentObservation, deletePhotoFromObservation, trackImageDeleted] );

  const onCropPhoto = useCallback( photo => {
    const cropUri = Photo.displayCropSourcePhoto( photo );
    if ( !cropUri ) {
      return;
    }

    const obsPhoto = observationPhotos.find( candidate => {
      const candidateUri = Photo.displayCropSourcePhoto( candidate.photo );
      const candidateLargeUri = Photo.displayLocalOrRemoteLargePhoto( candidate.photo );
      const candidateSquareUri = Photo.displayLocalOrRemoteSquarePhoto( candidate.photo );
      return candidateUri === cropUri
        || candidateLargeUri === Photo.displayLocalOrRemoteLargePhoto( photo )
        || candidateSquareUri === Photo.displayLocalOrRemoteSquarePhoto( photo );
    } );

    if ( !obsPhoto ) {
      return;
    }

    setSelectedMediaUri( null );
    navigation.navigate( "ImageCropEditor", {
      imageUri: cropUri,
      context: "observationEdit",
      observationPhotoUuid: obsPhoto.uuid,
      onCropSaved: () => setSelectedMediaUri( null ),
    } );
  }, [navigation, observationPhotos, setSelectedMediaUri] );

  const onDeleteSound = useCallback( async uriToDelete => {
    const obsSound = observationSounds.find( os => os.sound.file_url === uriToDelete );
    async function removeLocalSound( ) {
      deleteSoundFromObservation( uriToDelete );
      await ObservationSound.deleteLocalObservationSound(
        realm,
        uriToDelete,
        currentObservation.uuid,
      );
      afterMediaDeleted( uriToDelete );
    }
    setDeleting( true );
    // If sound was synced, delete the remote copy immediately and then remove
    // the local
    if ( obsSound?.id ) {
      deleteObservationSoundMutate( { uuid: obsSound.uuid }, {
        onSuccess: removeLocalSound,
        onError: deleteRemoteObservationSoundError => {
          setDeleting( false );
          logger.error(
            "[EvidenceList.js] failed to delete remote observation sound: ",
            deleteRemoteObservationSoundError,
          );
          Alert.alert(
            t( "Failed-to-delete-sound" ),
            t( "Please-try-again-when-you-are-connected-to-the-internet" ),
          );
        },
      } );
    } else {
      // If sound was not synced, just remove it locally
      await removeLocalSound( );
    }
  }, [
    afterMediaDeleted,
    currentObservation?.uuid,
    deleteObservationSoundMutate,
    deleteSoundFromObservation,
    realm,
    observationSounds,
    t,
  ] );

  const evidenceList = useMemo( ( ) => (
    <DraggableFlatList
      testID="EvidenceList.DraggableFlatList"
      horizontal
      data={photoUris}
      renderItem={renderPhoto}
      keyExtractor={obsPhoto => obsPhoto}
      onDragEnd={handleDragAndDrop}
      ListHeaderComponent={renderHeader}
      ListFooterComponent={renderFooter}
      className="py-5"
    />
  ), [
    handleDragAndDrop,
    photoUris,
    renderFooter,
    renderHeader,
    renderPhoto,
  ] );

  return (
    <>
      {evidenceList}
      <MediaViewerModal
        editable
        deleting={deleting}
        onClose={( ) => setSelectedMediaUri( null )}
        onCropPhoto={onCropPhoto}
        onDeletePhoto={onDeletePhoto}
        onDeleteSound={onDeleteSound}
        onReorderPhotos={handleDragAndDrop}
        photos={observationPhotos.map( obsPhoto => obsPhoto.photo )}
        showModal={!!selectedMediaUri || deleting}
        sounds={observationSounds.map( obsSound => obsSound.sound )}
        uri={selectedMediaUri}
      />
    </>
  );
};

export default EvidenceList;
