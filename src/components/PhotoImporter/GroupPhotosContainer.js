// @flow

import { useQueryClient } from "@tanstack/react-query";
import { duplicateGroupedMediaGroups } from
  "components/PhotoImporter/helpers/duplicateGroupedMedia";
import { bakePendingGroupPhotoCrops } from "components/PhotoImporter/helpers/groupPhotoCrops";
import {
  createObservationFromGroupedMedia,
} from "components/PhotoImporter/helpers/photoLibraryMediaHelpers";
import { RealmContext } from "providers/contexts";
import type { Node } from "react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert } from "react-native";
import {
  beginLocationWriteBatch,
  endLocationWriteBatch,
  saveObservationsAndApplyTrackedLocation,
} from "sharedHelpers/applyTrackedLocationToPhotos";
import {
  correctPhotosChromaticAberration,
  knownLensProfileCount,
  localFileUrisForObservations,
} from "sharedHelpers/chromaticAberration";
import {
  resolveDevicePhotoUriFromGroupedPhoto,
} from "sharedHelpers/deleteDevicePhotosDuringObservationPrep";
import { log } from "sharedHelpers/logger";
import { awaitPendingGroupPhotoCrops } from "sharedHelpers/pendingGroupPhotoCrops";
import {
  prefetchSuggestionsForObservations,
} from "sharedHelpers/prefetchObservationSuggestions";
import logRawImportMetadata from "sharedHelpers/rawImportMetadataLog";
import {
  addRemovedGroupPhotoUris,
  clearRemovedGroupPhotoUris,
} from "sharedHelpers/removedGroupPhotoUris";
import { moveSharedGroupedPhotos } from "sharedHelpers/shareExtensionFiles";
import { useExitObservationFlow, useGridLayout, useTranslation } from "sharedHooks";
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
  const queryClient = useQueryClient( );
  const { t } = useTranslation( );
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
  const [isCreatingObservations, setIsCreatingObservations] = useState( false );

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

  const separateObservations = observations => {
    let maxCombinedItems = 0;

    observations.forEach( obs => {
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
    const orderedPhotos = flattenAndOrderSelectedPhotos( observations );

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

  const duplicateObservations = async observations => {
    if ( observations.length === 0 ) {
      return;
    }

    setIsDuplicatingPhotos( true );
    try {
      const duplicatedGroups = await duplicateGroupedMediaGroups( observations );
      const indexToDuplicate = {};
      observations.forEach( ( obs, i ) => {
        const originalIndex = groupedPhotos.indexOf( obs );
        if ( originalIndex >= 0 ) {
          indexToDuplicate[originalIndex] = duplicatedGroups[i];
        }
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

  const removeObservations = observations => {
    const removedFromGroup = [];
    const orderedPhotos = flattenAndOrderSelectedPhotos( observations );

    // Record the removed photos' device URIs instead of deleting them. An
    // import no longer deletes anything from the library: every deletion is a
    // PHPhotoLibrary confirmation iOS can silently wedge, and doing that on
    // each import was both intrusive and unreliable. The URIs are saved
    // (see removedGroupPhotoUris.ts) so these stay hidden from the photo
    // picker and can be deleted in one pass later from Photo Cleanup.
    const deviceUrisToDelete = orderedPhotos
      .map( photo => resolveDevicePhotoUriFromGroupedPhoto( photo ) )
      .filter( Boolean );
    deviceUrisToDelete.forEach( uri => addPendingGroupPhotoDeletionUri( uri ) );
    addRemovedGroupPhotoUris( deviceUrisToDelete );

    // No line here: this fires on every photo the user removes (317 times in
    // five days, usually "staged 1"), and what was staged is reported again by
    // the deletion itself, which is where a problem would actually show up.

    groupedPhotos.forEach( obs => {
      if ( obs.soundUri !== undefined ) {
        if ( !observations.includes( obs ) ) {
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

  // The separate, duplicate, and remove buttons live on each photo, so they
  // always act on the photo they're drawn on rather than on the selection.
  const separateItem = item => separateObservations( [item] );
  const duplicateItem = item => duplicateObservations( [item] );
  const removeItem = item => removeObservations( [item] );

  // Backing out of Group Photos abandons the import entirely: nothing here has
  // been saved yet, and the grouped photos are persisted (see
  // useResumeGroupPhotos), so leaving any of this behind would drop the user
  // back into a stale import on the next cold start.
  const discardImport = useCallback( ( ) => {
    // Photos the user removed from the grid were recorded as "gone" so they'd
    // stay hidden from the photo picker. The import never happened, so give
    // them back rather than hiding photos that still exist on the device.
    clearRemovedGroupPhotoUris( pendingGroupPhotoDeletionUris );
    // Resets the observation flow slice: groupedPhotos, photoLibraryUris,
    // pendingGroupPhotoDeletionUris, and the rest of the import state. The
    // staged device photos are deliberately not deleted.
    exitObservationFlow( );
  }, [exitObservationFlow, pendingGroupPhotoDeletionUris] );

  const navBasedOnUserSettings = async ( ) => {
    setIsCreatingObservations( true );
    // Crops confirmed in the bulk cropper finish writing in the background so
    // the cropper can advance to the next photo instantly. Let them land in
    // the store first, or we'd import the uncropped photos. Normally a no-op:
    // they finish while the user is still cropping.
    await awaitPendingGroupPhotoCrops( );

    // Crops framed by pinching a photo in the grid are recorded on the photo
    // but not written to a file until here, so panning around the grid never
    // costs a full-resolution write per gesture.
    await bakePendingGroupPhotoCrops( );

    // Capture everything we need before navigating away, since exiting the
    // flow resets the store slice (groupedPhotos, pending deletion uris, etc.)
    // Read groupedPhotos from the store rather than the render closure, which
    // is stale if a background crop landed after the last render.
    const storedGroups = useStore.getState( ).groupedPhotos;

    // Photos handed to us by the share extension live in the App Group
    // container, which the main app can't read from after the extension goes
    // away, so they have to be staged into Documents before we import them.
    // A no-op for photos that came from the library or the camera.
    const movedGroups = await moveSharedGroupedPhotos( storedGroups );
    const groupsToImport = storedGroups.map( ( group, index ) => ( {
      ...group,
      photos: movedGroups[index].photos,
    } ) );
    setGroupedPhotos( groupsToImport );

    // Send the user to the Me page (My Observations) immediately. Observation
    // creation, saving, CV prefetch, and the optional delete-originals prompt
    // all continue in the background below.
    resetMyObsOffsetToRestore( );
    setMyObsOffset( 0 );
    exitObservationFlow( );

    // Process in batches to avoid spawning hundreds of concurrent native image
    // resize operations (Photo.resizeImageForUpload) which exhausts resources.
    // Each batch is created, saved, located and handed to the CV prefetch
    // before the next one starts, so scoring the first observations begins
    // while the rest of the import is still being written. Waiting for the
    // whole import first meant a 100-photo import scored nothing until every
    // photo had been resized and saved — by which time the user was already
    // looking at Suggestions.
    const BATCH_SIZE = 10;
    // Prefetches are chained rather than fired per batch so they still run one
    // observation at a time, instead of every batch's CV work piling up
    // concurrently.
    let prefetchChain = Promise.resolve( );
    // Photos whose metadata could not be read are left out rather than imported
    // without it, and reported once at the end: a location silently missing
    // from an observation is invisible until long after the photo is gone.
    let failedCount = 0;
    let defaultsApplied = false;
    // Once per import, and only when a raw came through: what the file held,
    // and how much of it survived into the JPEG the observation carries.
    let rawMetadataLogged = false;
    // iOS cannot demosaic a CR3, so the pixels an imported raw carries are the
    // preview the camera embedded — and a camera set to correct chromatic
    // aberration has already corrected that preview. Measuring one finds the
    // subject rather than the lens: an EOS R7 preview measured a 0.97px spike
    // mid-frame and nothing at the corners, where the same frame's sensor data
    // measured a clean 1.51px profile that held all the way out.
    let cameraAlreadyCorrectedCa = false;
    // Totalled across batches so the import reports one line, not one per ten
    // photos.
    const chromaticAberration = {
      corrected: 0, skipped: 0, failed: 0, measured: 0, fromProfile: 0, maxShiftPx: 0, ms: 0,
    };
    // One Photos-library transaction (and so one iOS consent alert) for the
    // whole import, however many batches its location writes arrive in.
    beginLocationWriteBatch( );
    try {
      for ( let i = 0; i < groupsToImport.length; i += BATCH_SIZE ) {
        const batch = groupsToImport.slice( i, i + BATCH_SIZE );
        // eslint-disable-next-line no-await-in-loop
        const batchResults = await Promise.allSettled(
          batch.map( createObservationFromGroupedMedia ),
        );
        const observationsToSave = [];
        for ( const result of batchResults ) {
          if ( result.status === "rejected" ) {
            failedCount += 1;
            logger.error(
              "Failed to create an observation from imported media",
              result.reason,
            );
          } else {
            observationsToSave.push( {
              ...( defaultsApplied
                ? {}
                : firstObservationDefaults ),
              ...result.value,
            } );
            defaultsApplied = true;
          }
        }
        if ( observationsToSave.length === 0 ) {
          // eslint-disable-next-line no-continue
          continue;
        }

        if ( !rawMetadataLogged ) {
          rawMetadataLogged = true;
          const sourceUris = batch.flatMap( group => ( group.photos || [] ).map(
            photo => photo.image?.cropOriginalUri || photo.image?.uri,
          ) );
          // Awaited, because what the raw says about in-camera correction
          // decides whether the correction below is worth doing at all. It
          // reads a header and one record, not the whole file.
          // eslint-disable-next-line no-await-in-loop
          const rawSummary = await logRawImportMetadata(
            sourceUris,
            localFileUrisForObservations( observationsToSave ),
          ).catch( error => {
            logger.error( "Failed to report raw import metadata", error );
            return null;
          } );
          if ( rawSummary?.chromaticAberrationCorrection === 1 ) {
            cameraAlreadyCorrectedCa = true;
            logger.infoWithExtra( "chromatic_aberration_not_needed", {
              reason: "the camera corrected the preview these photos came from",
              camera: rawSummary.camera || "",
              lens: rawSummary.lens || "",
            } );
          }
        }

        // Correct lateral chromatic aberration before anything reads these
        // files: the photo the observation carries from here on is the one
        // that gets scored, shown and uploaded. Measured per photo from the
        // photo itself, so it costs nothing on a lens that doesn't fringe —
        // those come back "nothing to correct" and are left untouched.
        let caSummary = null;
        if ( !cameraAlreadyCorrectedCa ) {
          // eslint-disable-next-line no-await-in-loop
          caSummary = await correctPhotosChromaticAberration(
            localFileUrisForObservations( observationsToSave ),
          );
        }
        if ( caSummary ) {
          chromaticAberration.corrected += caSummary.corrected;
          chromaticAberration.skipped += caSummary.skipped;
          chromaticAberration.failed += caSummary.failed;
          chromaticAberration.measured += caSummary.measured;
          chromaticAberration.fromProfile += caSummary.fromProfile;
          chromaticAberration.ms += caSummary.ms;
          chromaticAberration.maxShiftPx = Math.max(
            chromaticAberration.maxShiftPx,
            caSummary.maxShiftPx,
          );
        }

        // Save each observation and auto-fill tracked location for any that
        // ended up without one. Saves happen independently so a single failed
        // save can't abort the whole import (the observations that did save
        // would otherwise never reach the location auto-fill and would land
        // with no location). This runs before the ID requests below so
        // computer vision scoring (and its cache key) use the observation's
        // final location rather than no location.
        // eslint-disable-next-line no-await-in-loop
        const trackedLocationByUuid = await saveObservationsAndApplyTrackedLocation(
          observationsToSave,
          realm,
        );

        // Mirror any auto-filled locations back onto the in-memory
        // observations so the CV prefetch (and its cache key) reflects the
        // observation's final location.
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

        // Now that locations are populated, start scoring each new
        // observation's photo (offline + online), caching both so the
        // Suggestions screen loads instantly and no photo is ever scored
        // twice. Fire-and-forget so import isn't blocked on CV.
        prefetchChain = prefetchChain
          .then( ( ) => prefetchSuggestionsForObservations(
            queryClient,
            locatedObservations,
            realm,
          ) )
          .catch( error => logger.error(
            "Failed to prefetch group photo suggestions",
            error,
          ) );
      }
    } finally {
      await endLocationWriteBatch( );
    }

    if ( chromaticAberration.corrected > 0 || chromaticAberration.failed > 0 ) {
      logger.infoWithExtra( "group_photos_chromatic_aberration", {
        ...chromaticAberration,
        // Cumulative, not this import's: it says how much of the next one will
        // need no measuring.
        lensProfilesKnown: knownLensProfileCount( ),
      } );
    }

    if ( failedCount > 0 ) {
      logger.error(
        `Skipped ${failedCount} of ${groupsToImport.length} item(s): metadata unreadable`,
      );
      Alert.alert(
        t( "Something-went-wrong" ),
        t( "X-photos-could-not-be-imported-with-their-metadata", { count: failedCount } ),
      );
    }
  };

  return (
    <GroupPhotos
      combinePhotos={combinePhotos}
      discardImport={discardImport}
      duplicateItem={duplicateItem}
      flashListRef={flashListRef}
      groupedPhotos={groupedPhotos}
      isCreatingObservations={isCreatingObservations}
      isDuplicatingPhotos={isDuplicatingPhotos}
      navBasedOnUserSettings={navBasedOnUserSettings}
      onScroll={onScroll}
      onViewableItemsChanged={onViewableItemsChanged}
      removeItem={removeItem}
      selectObservationPhotos={selectObservationPhotos}
      selectedObservations={selectedObservations}
      separateItem={separateItem}
    />
  );
};

export default GroupPhotosContainer;
