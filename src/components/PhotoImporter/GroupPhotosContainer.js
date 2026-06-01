// @flow

import { useNavigation } from "@react-navigation/native";
import { MAX_PHOTOS_ALLOWED } from "components/Camera/StandardCamera/StandardCamera";
import { duplicateGroupedMediaGroups } from
  "components/PhotoImporter/helpers/duplicateGroupedMedia";
import {
  createObservationFromGroupedMedia,
} from "components/PhotoImporter/helpers/photoLibraryMediaHelpers";
import { t } from "i18next";
import type { Node } from "react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  resolveDevicePhotoUriFromGroupedPhoto,
} from "sharedHelpers/deleteDevicePhotosDuringObservationPrep";
import { useLayoutPrefs } from "sharedHooks";
import useStore from "stores/useStore";

import GroupPhotos from "./GroupPhotos";
import flattenAndOrderSelectedPhotos, {
  flattenAndOrderSelectedVideos,
  selectedGroupsHaveMixedMedia,
} from "./helpers/groupPhotoHelpers";

function findScrollTargetIndex( newPhotos, uri, fallbackIndex ) {
  if ( uri == null ) return null;
  const index = newPhotos.findIndex( obs => obs.photos?.some( p => p.image.uri === uri ) );
  if ( index >= 0 ) return index;
  if ( fallbackIndex != null && newPhotos.length > 0 ) {
    return Math.min( fallbackIndex, newPhotos.length - 1 );
  }
  return null;
}

const GroupPhotosContainer = ( ): Node => {
  const navigation = useNavigation( );
  const {
    screenAfterPhotoEvidence, isDefaultMode,
  } = useLayoutPrefs( );
  const setObservations = useStore( state => state.setObservations );
  const setGroupedPhotos = useStore( state => state.setGroupedPhotos );
  const groupedPhotos = useStore( state => state.groupedPhotos );
  const firstObservationDefaults = useStore( state => state.firstObservationDefaults ) || {};
  const pendingGroupPhotoDeletionUris = useStore( state => state.pendingGroupPhotoDeletionUris );

  const [selectedIndices, setSelectedIndices] = useState( [] );
  const [isCreatingObservations, setIsCreatingObservations] = useState( false );
  const [isDuplicatingPhotos, setIsDuplicatingPhotos] = useState( false );
  const [pendingDeletionUris, setPendingDeletionUris] = useState( [] );

  const selectedObservations = useMemo(
    ( ) => selectedIndices
      .map( index => groupedPhotos[index] )
      .filter( Boolean ),
    [groupedPhotos, selectedIndices],
  );

  useEffect( ( ) => {
    setSelectedIndices( prev => prev.filter(
      index => index >= 0 && index < groupedPhotos.length,
    ) );
  }, [groupedPhotos.length] );

  const flashListRef = useRef( null );
  const firstVisibleItemUri = useRef( null );
  const firstVisibleItemIndex = useRef( null );
  const pendingScrollIndex = useRef( null );

  const onViewableItemsChanged = useCallback( ( { viewableItems } ) => {
    const firstVisible = viewableItems.find( vi => vi.item?.photos );
    if ( firstVisible ) {
      firstVisibleItemUri.current = firstVisible.item.photos[0]?.image?.uri ?? null;
      firstVisibleItemIndex.current = firstVisible.index ?? null;
    }
  }, [] );

  useEffect( ( ) => {
    let timer;
    if ( pendingScrollIndex.current !== null ) {
      const index = pendingScrollIndex.current;
      pendingScrollIndex.current = null;
      timer = setTimeout( ( ) => {
        flashListRef.current?.scrollToIndex( { index, animated: false } );
      }, 0 );
    }
    return ( ) => clearTimeout( timer );
  }, [groupedPhotos] );

  const totalPhotos = groupedPhotos
    .reduce( ( count, current ) => (
      count + ( current.photos?.length || current.videos?.length || 0 )
    ), 0 );

  useEffect( ( ) => {
    navigation.setOptions( {
      headerTitle: t( "Group-Photos" ),
      headerSubtitle: t( "X-PHOTOS-X-OBSERVATIONS", {
        photoCount: totalPhotos,
        observationCount: groupedPhotos.length,
      } ),
    } );
  }, [totalPhotos, groupedPhotos, navigation] );

  const selectAllPhotos = () => {
    setSelectedIndices( groupedPhotos.map( ( _obs, index ) => index ) );
  };

  const selectObservationPhotos = ( isSelected, observation ) => {
    const index = groupedPhotos.indexOf( observation );
    if ( index < 0 ) {
      return;
    }

    if ( !isSelected ) {
      setSelectedIndices( prev => (
        prev.includes( index )
          ? prev
          : [...prev, index]
      ) );
    } else {
      setSelectedIndices( prev => prev.filter( selectedIndex => selectedIndex !== index ) );
    }
  };

  const combinePhotos = () => {
    if ( selectedObservations.length < 2 ) {
      return;
    }

    if ( selectedGroupsHaveMixedMedia( selectedObservations ) ) {
      return;
    }

    const isVideoSelection = selectedObservations.some(
      obs => obs.videos?.length > 0,
    );
    const orderedPhotos = flattenAndOrderSelectedPhotos( selectedObservations );
    const orderedVideos = flattenAndOrderSelectedVideos( selectedObservations );
    const mostRecentPhoto = orderedPhotos[0];
    const mostRecentVideo = orderedVideos[0];
    const newObsList = [];

    groupedPhotos.forEach( obs => {
      if ( isVideoSelection ) {
        const containsSelected = mostRecentVideo && obs.videos?.some(
          video => video.uri === mostRecentVideo.uri,
        );

        if ( containsSelected ) {
          newObsList.push( { videos: orderedVideos } );
        } else {
          const filteredVideos = obs.videos?.filter(
            video => !orderedVideos.some( item => item.uri === video.uri ),
          );
          if ( filteredVideos?.length > 0 ) {
            newObsList.push( { videos: filteredVideos } );
          }
        }
      } else {
        const containsSelected = mostRecentPhoto && obs.photos?.includes( mostRecentPhoto );

        if ( containsSelected ) {
          newObsList.push( { photos: orderedPhotos } );
        } else {
          const filteredPhotos = obs.photos?.filter(
            item => !orderedPhotos.includes( item ),
          );
          if ( filteredPhotos?.length > 0 ) {
            newObsList.push( { photos: filteredPhotos } );
          }
        }
      }
    } );

    const targetIndex = findScrollTargetIndex(
      newObsList,
      firstVisibleItemUri.current,
      firstVisibleItemIndex.current,
    );
    if ( targetIndex !== null ) {
      pendingScrollIndex.current = targetIndex;
    }
    setGroupedPhotos( newObsList );
    setSelectedIndices( [] );
  };

  const separatePhotos = () => {
    let maxCombinedItems = 0;

    selectedObservations.forEach( obs => {
      const numItems = obs.photos?.length || obs.videos?.length || 0;
      if ( numItems > maxCombinedItems ) {
        maxCombinedItems = numItems;
      }
    } );

    if ( maxCombinedItems < 2 ) {
      return;
    }

    const separatedItems = [];
    const orderedPhotos = flattenAndOrderSelectedPhotos( selectedObservations );
    const orderedVideos = flattenAndOrderSelectedVideos( selectedObservations );

    groupedPhotos.forEach( obs => {
      const filteredGroupedPhotos = obs.photos?.filter(
        item => orderedPhotos.includes( item ),
      ) || [];
      const filteredGroupedVideos = obs.videos?.filter(
        item => orderedVideos.some( video => video.uri === item.uri ),
      ) || [];

      if ( filteredGroupedPhotos.length > 0 ) {
        filteredGroupedPhotos.forEach( photo => {
          separatedItems.push( { photos: [photo] } );
        } );
      } else if ( filteredGroupedVideos.length > 0 ) {
        filteredGroupedVideos.forEach( video => {
          separatedItems.push( { videos: [video] } );
        } );
      } else {
        separatedItems.push( obs );
      }
    } );

    const targetIndex = findScrollTargetIndex(
      separatedItems,
      firstVisibleItemUri.current,
      firstVisibleItemIndex.current,
    );
    if ( targetIndex !== null ) {
      pendingScrollIndex.current = targetIndex;
    }
    setGroupedPhotos( separatedItems );
    setSelectedIndices( [] );
  };

  const selectedMediaCount = selectedObservations.reduce(
    ( count, obs ) => count + ( obs.photos?.length || obs.videos?.length || 0 ),
    0,
  );

  const duplicatePhotos = async ( ) => {
    if (
      selectedObservations.length === 0
      || selectedGroupsHaveMixedMedia( selectedObservations )
      || totalPhotos + selectedMediaCount > MAX_PHOTOS_ALLOWED
    ) {
      return;
    }

    setIsDuplicatingPhotos( true );
    try {
      const duplicatedGroups = await duplicateGroupedMediaGroups( selectedObservations );
      const indexToDuplicate = {};
      selectedIndices.forEach( ( originalIndex, i ) => {
        indexToDuplicate[originalIndex] = duplicatedGroups[i];
      } );
      const newGroupedPhotos = [];
      groupedPhotos.forEach( ( group, index ) => {
        newGroupedPhotos.push( group );
        if ( indexToDuplicate[index] !== undefined ) {
          newGroupedPhotos.push( indexToDuplicate[index] );
        }
      } );
      setGroupedPhotos( newGroupedPhotos );
      setSelectedIndices( [] );
    } finally {
      setIsDuplicatingPhotos( false );
    }
  };

  const removePhotos = () => {
    const removedFromGroup = [];
    const orderedPhotos = flattenAndOrderSelectedPhotos( selectedObservations );
    const orderedVideos = flattenAndOrderSelectedVideos( selectedObservations );

    const urisToDelete = orderedPhotos
      .map( photo => resolveDevicePhotoUriFromGroupedPhoto( photo ) )
      .filter( Boolean );
    if ( urisToDelete.length > 0 ) {
      setPendingDeletionUris( prev => [...new Set( [...prev, ...urisToDelete] )] );
    }

    groupedPhotos.forEach( obs => {
      const filteredGroupedPhotos = obs.photos?.filter(
        item => !orderedPhotos.includes( item ),
      ) || [];
      const filteredGroupedVideos = obs.videos?.filter(
        item => !orderedVideos.some( video => video.uri === item.uri ),
      ) || [];

      if ( filteredGroupedPhotos.length > 0 ) {
        removedFromGroup.push( { photos: filteredGroupedPhotos } );
      } else if ( filteredGroupedVideos.length > 0 ) {
        removedFromGroup.push( { videos: filteredGroupedVideos } );
      }
    } );

    const targetIndex = findScrollTargetIndex(
      removedFromGroup,
      firstVisibleItemUri.current,
      firstVisibleItemIndex.current,
    );
    if ( targetIndex !== null ) {
      pendingScrollIndex.current = targetIndex;
    }
    setGroupedPhotos( removedFromGroup );
    setSelectedIndices( [] );
  };

  const navBasedOnUserSettings = async ( ) => {
    setIsCreatingObservations( true );

    // Process in batches to avoid spawning hundreds of concurrent native image
    // resize operations (Photo.resizeImageForUpload) which exhausts resources
    const BATCH_SIZE = 10;
    const newObservations = [];
    for ( let i = 0; i < groupedPhotos.length; i += BATCH_SIZE ) {
      const batch = groupedPhotos.slice( i, i + BATCH_SIZE );
      // eslint-disable-next-line no-await-in-loop
      const batchResults = await Promise.all( batch.map( createObservationFromGroupedMedia ) );
      newObservations.push( ...batchResults );
    }
    setObservations( newObservations.map( ( newObs, idx ) => ( {
      ...( idx === 0
        ? firstObservationDefaults
        : {}
      ),
      ...newObs,
    } ) ) );
    setIsCreatingObservations( false );

    const navigateToNextScreen = ( ) => {
      if ( newObservations.length === 1 ) {
        const onlyObservation = newObservations[0];
        if ( onlyObservation.observationSounds?.length ) {
          return navigation.navigate( "ObsEdit", { lastScreen: "GroupPhotos" } );
        }

        if ( isDefaultMode ) {
          return navigation.navigate( "NoBottomTabStackNavigator", {
            screen: "Match",
            params: {
              entryScreen: "GroupPhotos",
              lastScreen: "GroupPhotos",
            },
          } );
        }

        return navigation.navigate( "NoBottomTabStackNavigator", {
          screen: screenAfterPhotoEvidence,
          params: {
            entryScreen: "GroupPhotos",
            lastScreen: "GroupPhotos",
          },
        } );
      }
      return navigation.navigate( "ObsEdit", { lastScreen: "GroupPhotos" } );
    };

    const allPendingUris = [
      ...new Set( [...pendingDeletionUris, ...pendingGroupPhotoDeletionUris] ),
    ];
    if ( allPendingUris.length > 0 ) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const promptDeleteOriginalDevicePhotos = require(
        "sharedHelpers/promptDeleteOriginalDevicePhotos",
      ).default;
      promptDeleteOriginalDevicePhotos( allPendingUris, navigateToNextScreen );
    } else {
      navigateToNextScreen( );
    }
  };

  return (
    <GroupPhotos
      combinePhotos={combinePhotos}
      clearSelection={() => setSelectedIndices( [] )}
      duplicatePhotos={duplicatePhotos}
      flashListRef={flashListRef}
      groupedPhotos={groupedPhotos}
      isCreatingObservations={isCreatingObservations}
      isDuplicatingPhotos={isDuplicatingPhotos}
      navBasedOnUserSettings={navBasedOnUserSettings}
      onViewableItemsChanged={onViewableItemsChanged}
      removePhotos={removePhotos}
      selectedMediaCount={selectedMediaCount}
      maxPhotosAllowed={MAX_PHOTOS_ALLOWED}
      selectAllPhotos={selectAllPhotos}
      selectObservationPhotos={selectObservationPhotos}
      selectedObservations={selectedObservations}
      separatePhotos={separatePhotos}
      totalPhotos={totalPhotos}
      selectedGroupsHaveMixedMedia={selectedGroupsHaveMixedMedia( selectedObservations )}
    />
  );
};

export default GroupPhotosContainer;
