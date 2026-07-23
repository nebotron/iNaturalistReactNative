// @flow

import { useNavigation } from "@react-navigation/native";
import { useQueryClient } from "@tanstack/react-query";
import { duplicateGroupedMediaGroups } from
  "components/PhotoImporter/helpers/duplicateGroupedMedia";
import {
  createObservationFromGroupedMedia,
} from "components/PhotoImporter/helpers/photoLibraryMediaHelpers";
import { t } from "i18next";
import { RealmContext } from "providers/contexts";
import type { Node } from "react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Observation from "realmModels/Observation";
import { autoApplyTrackedLocationIfMissing } from "sharedHelpers/applyTrackedLocationToPhotos";
import {
  resolveDevicePhotoUriFromGroupedPhoto,
} from "sharedHelpers/deleteDevicePhotosDuringObservationPrep";
import {
  filterUsableTrackedPoints,
} from "sharedHelpers/interpolateTrackedLocation";
import { log } from "sharedHelpers/logger";
import {
  prefetchSuggestionsForObservations,
} from "sharedHelpers/prefetchObservationSuggestions";
import { useExitObservationFlow, useGridLayout } from "sharedHooks";
import useStore from "stores/useStore";

import GroupPhotos from "./GroupPhotos";
import flattenAndOrderSelectedPhotos, {
  sortGroupsByTime,
} from "./helpers/groupPhotoHelpers";

const { useRealm } = RealmContext;

const logger = log.extend( "GroupPhotosContainer" );

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
  const queryClient = useQueryClient( );
  const { gridItemStyle } = useGridLayout( undefined, "fullWidth" );
  const itemHeight = gridItemStyle.height;
  const realm = useRealm( );
  const exitObservationFlow = useExitObservationFlow( );
  const setGroupedPhotos = useStore( state => state.setGroupedPhotos );
  const groupedPhotos = useStore( state => state.groupedPhotos );
  const firstObservationDefaults = useStore( state => state.firstObservationDefaults ) || {};
  const pendingGroupPhotoDeletionUris = useStore( state => state.pendingGroupPhotoDeletionUris );
  const addPendingGroupPhotoDeletionUri = useStore(
    state => state.addPendingGroupPhotoDeletionUri,
  );
  const resetMyObsOffsetToRestore = useStore( state => state.resetMyObsOffsetToRestore );
  const setMyObsOffset = useStore( state => state.setMyObsOffset );

  const [selectedIndices, setSelectedIndices] = useState( [] );
  const [isDuplicatingPhotos, setIsDuplicatingPhotos] = useState( false );

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
  const pendingScrollOffset = useRef( null );
  const scrollOffset = useRef( 0 );

  const onScroll = useCallback( event => {
    scrollOffset.current = event.nativeEvent.contentOffset.y;
  }, [] );

  const onViewableItemsChanged = useCallback( ( { viewableItems } ) => {
    const firstVisible = viewableItems.find( vi => vi.item?.photos );
    if ( firstVisible ) {
      firstVisibleItemUri.current = firstVisible.item.photos[0]?.image?.uri ?? null;
      firstVisibleItemIndex.current = firstVisible.index ?? null;
    }
  }, [] );

  useEffect( ( ) => {
    let timer;
    if ( pendingScrollOffset.current !== null ) {
      const offset = pendingScrollOffset.current;
      pendingScrollOffset.current = null;
      timer = setTimeout( ( ) => {
        flashListRef.current?.scrollToOffset( { offset, animated: false } );
      }, 0 );
    }
    return ( ) => clearTimeout( timer );
  }, [groupedPhotos] );

  const totalPhotos = groupedPhotos
    .reduce( ( count, current ) => count + ( current.photos?.length || 0 ), 0 );

  useEffect( ( ) => {
    navigation.setOptions( {
      headerTitle: t( "Group-Photos" ),
      headerSubtitle: t( "X-PHOTOS-X-OBSERVATIONS", {
        photoCount: totalPhotos,
        observationCount: groupedPhotos.length,
      } ),
      onBackPress: ( ) => exitObservationFlow( ),
    } );
  }, [totalPhotos, groupedPhotos, navigation, exitObservationFlow] );

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

  const setPendingScrollOffset = useCallback( targetIndex => {
    if ( targetIndex === null ) return;
    const oldIndex = firstVisibleItemIndex.current ?? targetIndex;
    const delta = targetIndex - oldIndex;
    pendingScrollOffset.current = Math.max( 0, scrollOffset.current + delta * itemHeight );
  }, [itemHeight] );

  const combinePhotos = () => {
    if ( selectedObservations.length < 2 ) {
      return;
    }

    const orderedPhotos = flattenAndOrderSelectedPhotos( selectedObservations );
    if ( orderedPhotos.length === 0 ) {
      return;
    }
    const mostRecentPhoto = orderedPhotos[0];
    // Collect soundUris from all selected items (sound-only or mixed groups)
    const selectedSoundUris = selectedObservations
      .filter( obs => obs.soundUri )
      .map( obs => obs.soundUri );
    const newObsList = [];

    groupedPhotos.forEach( obs => {
      // Sound-only items: merge into combined group if selected, else keep
      if ( obs.soundUri !== undefined && !obs.photos?.length ) {
        if ( !selectedObservations.includes( obs ) ) {
          newObsList.push( obs );
        }
        return;
      }
      const containsSelected = mostRecentPhoto && obs.photos?.includes( mostRecentPhoto );

      if ( containsSelected ) {
        const combinedGroup = selectedSoundUris.length > 0
          ? { photos: orderedPhotos, soundUri: selectedSoundUris[0] }
          : { photos: orderedPhotos };
        newObsList.push( combinedGroup );
      } else {
        const filteredPhotos = obs.photos?.filter(
          item => !orderedPhotos.includes( item ),
        );
        if ( filteredPhotos?.length > 0 ) {
          const group = obs.soundUri
            ? { photos: filteredPhotos, soundUri: obs.soundUri }
            : { photos: filteredPhotos };
          newObsList.push( group );
        }
      }
    } );

    // Extra selected sounds (beyond the first) remain as separate items
    for ( let i = 1; i < selectedSoundUris.length; i += 1 ) {
      newObsList.push( { soundUri: selectedSoundUris[i] } );
    }

    setPendingScrollOffset( findScrollTargetIndex(
      newObsList,
      firstVisibleItemUri.current,
      firstVisibleItemIndex.current,
    ) );
    setGroupedPhotos( newObsList );
    setSelectedIndices( [] );
  };

  const separatePhotos = () => {
    let maxCombinedItems = 0;

    selectedObservations.forEach( obs => {
      // Count photos + sound as separate items for the threshold check
      const numItems = ( obs.photos?.length || 0 ) + ( obs.soundUri
        ? 1
        : 0 );
      if ( numItems > maxCombinedItems ) {
        maxCombinedItems = numItems;
      }
    } );

    if ( maxCombinedItems < 2 ) {
      return;
    }

    const separatedItems = [];
    const orderedPhotos = flattenAndOrderSelectedPhotos( selectedObservations );

    groupedPhotos.forEach( obs => {
      const filteredGroupedPhotos = obs.photos?.filter(
        item => orderedPhotos.includes( item ),
      ) || [];

      if ( filteredGroupedPhotos.length > 0 ) {
        filteredGroupedPhotos.forEach( photo => {
          separatedItems.push( { photos: [photo] } );
        } );
        // If the group had a sound, keep it as a separate item
        if ( obs.soundUri ) {
          separatedItems.push( { soundUri: obs.soundUri, timestamp: obs.timestamp } );
        }
      } else {
        separatedItems.push( obs );
      }
    } );

    const sortedSeparatedItems = sortGroupsByTime( separatedItems );
    setPendingScrollOffset( findScrollTargetIndex(
      sortedSeparatedItems,
      firstVisibleItemUri.current,
      firstVisibleItemIndex.current,
    ) );
    setGroupedPhotos( sortedSeparatedItems );
    setSelectedIndices( [] );
  };

  const selectedMediaCount = selectedObservations.reduce(
    ( count, obs ) => count + ( obs.photos?.length || 0 ),
    0,
  );

  const duplicatePhotos = async ( ) => {
    if ( selectedObservations.length === 0 ) {
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

    // Stage the removed photos' device URIs for deletion rather than deleting
    // here: the Group Photos screen is presented modally, and iOS can't present
    // its deletion-confirmation over a modal RN screen (the request silently
    // hangs). Deletion runs in navBasedOnUserSettings after the modal is
    // dismissed and we're on the stable My Observations screen.
    const deviceUrisToDelete = orderedPhotos
      .map( photo => resolveDevicePhotoUriFromGroupedPhoto( photo ) )
      .filter( Boolean );
    deviceUrisToDelete.forEach( uri => addPendingGroupPhotoDeletionUri( uri ) );

    logger.info(
      `removePhotos: staged ${deviceUrisToDelete.length} device URI(s) `
      + `from ${orderedPhotos.length} removed photo(s) for deletion`,
    );

    groupedPhotos.forEach( obs => {
      if ( obs.soundUri !== undefined ) {
        if ( !selectedObservations.includes( obs ) ) {
          removedFromGroup.push( obs );
        }
        return;
      }
      const filteredGroupedPhotos = obs.photos?.filter(
        item => !orderedPhotos.includes( item ),
      ) || [];

      if ( filteredGroupedPhotos.length > 0 ) {
        removedFromGroup.push( { photos: filteredGroupedPhotos } );
      }
    } );

    setPendingScrollOffset( findScrollTargetIndex(
      removedFromGroup,
      firstVisibleItemUri.current,
      firstVisibleItemIndex.current,
    ) );
    setGroupedPhotos( removedFromGroup );
    setSelectedIndices( [] );
  };

  const navBasedOnUserSettings = async ( ) => {
    // Capture everything we need before navigating away, since exiting the
    // flow resets the store slice (groupedPhotos, pending deletion uris, etc.)
    const groupsToImport = groupedPhotos;
    const allPendingUris = [...new Set( pendingGroupPhotoDeletionUris )];

    // Send the user to the Me page (My Observations) immediately. Observation
    // creation, saving, CV prefetch, and the optional delete-originals prompt
    // all continue in the background below.
    resetMyObsOffsetToRestore( );
    setMyObsOffset( 0 );
    exitObservationFlow( );

    // Process in batches to avoid spawning hundreds of concurrent native image
    // resize operations (Photo.resizeImageForUpload) which exhausts resources
    const BATCH_SIZE = 10;
    const newObservations = [];
    for ( let i = 0; i < groupsToImport.length; i += BATCH_SIZE ) {
      const batch = groupsToImport.slice( i, i + BATCH_SIZE );
      // eslint-disable-next-line no-await-in-loop
      const batchResults = await Promise.all( batch.map( createObservationFromGroupedMedia ) );
      newObservations.push( ...batchResults );
    }
    const observationsToSave = newObservations.map( ( newObs, idx ) => ( {
      ...( idx === 0
        ? firstObservationDefaults
        : {}
      ),
      ...newObs,
    } ) );

    await Promise.all(
      observationsToSave.map( obs => Observation.saveLocalObservationForUpload( obs, realm ) ),
    );

    // Auto-fill location from tracked location history for any imported
    // observation whose photos didn't carry GPS EXIF data. This runs before
    // the ID requests below so computer vision scoring (and its cache key) use
    // the observation's final location rather than no location.
    const trackedLocationByUuid = {};
    const missingLocationObs = observationsToSave
      .filter( obs => obs.latitude == null || obs.longitude == null );
    if ( missingLocationObs.length > 0 ) {
      // Filter the (potentially large) point history once and reuse it for
      // every observation, rather than re-filtering per observation.
      const usablePoints = filterUsableTrackedPoints(
        realm.objects( "LocationHistoryPoint" ).sorted( "recordedAt" ),
      );
      await Promise.all( missingLocationObs.map( async obs => {
        const savedObs = realm.objectForPrimaryKey( "Observation", obs.uuid );
        if ( !savedObs ) return;
        const applied = await autoApplyTrackedLocationIfMissing( realm, savedObs, usablePoints );
        if ( applied ) {
          trackedLocationByUuid[obs.uuid] = {
            latitude: savedObs.latitude,
            longitude: savedObs.longitude,
            accuracy: savedObs.positional_accuracy ?? null,
          };
        }
      } ) );
    }

    // Mirror any auto-filled locations back onto the in-memory observations so
    // the CV prefetch (and its cache key) reflects the observation's final
    // location.
    const locatedObservations = observationsToSave.map( obs => {
      const trackedLocation = trackedLocationByUuid[obs.uuid];
      if ( !trackedLocation ) return obs;
      return {
        ...obs,
        latitude: trackedLocation.latitude,
        longitude: trackedLocation.longitude,
        ...( trackedLocation.accuracy != null
          ? { positional_accuracy: trackedLocation.accuracy }
          : {} ),
      };
    } );

    // Now that locations are populated, start scoring each new observation's
    // photo (offline + online), caching both so the Suggestions screen loads
    // instantly and no photo is ever scored twice. Fire-and-forget so import
    // isn't blocked on CV.
    prefetchSuggestionsForObservations( queryClient, locatedObservations, realm )
      .catch( error => logger.error( "Failed to prefetch group photo suggestions", error ) );

    if ( allPendingUris.length > 0 ) {
      // The iOS deletion confirmation can't present over the (now-dismissed)
      // Group Photos modal. Wait for the navigation reset to My Observations to
      // finish settling so the confirmation presents on that stable screen
      // rather than mid-transition (which silently hangs the request).
      await new Promise( resolve => { setTimeout( resolve, 800 ); } );
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { deleteOriginalDevicePhotos } = require(
        "sharedHelpers/promptDeleteOriginalDevicePhotos",
      );
      await deleteOriginalDevicePhotos( allPendingUris, { userInitiated: true } );
    }
  };

  return (
    <GroupPhotos
      combinePhotos={combinePhotos}
      clearSelection={() => setSelectedIndices( [] )}
      duplicatePhotos={duplicatePhotos}
      flashListRef={flashListRef}
      groupedPhotos={groupedPhotos}
      isDuplicatingPhotos={isDuplicatingPhotos}
      navBasedOnUserSettings={navBasedOnUserSettings}
      onScroll={onScroll}
      onViewableItemsChanged={onViewableItemsChanged}
      removePhotos={removePhotos}
      selectedMediaCount={selectedMediaCount}
      selectAllPhotos={selectAllPhotos}
      selectObservationPhotos={selectObservationPhotos}
      selectedObservations={selectedObservations}
      separatePhotos={separatePhotos}
      totalPhotos={totalPhotos}
    />
  );
};

export default GroupPhotosContainer;
