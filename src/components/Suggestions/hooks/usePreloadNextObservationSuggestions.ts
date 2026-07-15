import { useQueryClient } from "@tanstack/react-query";
import { RealmContext } from "providers/contexts";
import { useEffect, useRef } from "react";
import type { RealmObservationPojo } from "realmModels/types";
import scoreObservationOffline from "sharedHelpers/bulkIdentifyOffline";
import { log } from "sharedHelpers/logger";
import prefetchObservationSuggestions from "sharedHelpers/prefetchObservationSuggestions";
import useStore from "stores/useStore";

const { useRealm } = RealmContext;

const logger = log.extend( "usePreloadNextObservationSuggestions" );

// Orchestrates identification for the bulk (multi-observation) flow:
//   1. Run the offline model for every queued observation up front, recording
//      the confidence of each one's top species.
//   2. Fire online ID requests, least-confident-offline first, since those are
//      the ones most likely to benefit from the online model.
//   3. Continuously reorder the not-yet-viewed observations so the next one to
//      ID is the best available: those whose online ID has finished come first,
//      otherwise the most confident offline ID.
// Everything is pipelined so the user rarely waits: the offline pass makes an
// instant suggestion available for every observation, and online results are
// pre-warmed into the cache before their observation is reached.
const usePreloadNextObservationSuggestions = ( ) => {
  const queryClient = useQueryClient( );
  const realm = useRealm( );
  const observations = useStore( state => state.observations );
  const savedOrUploadedMultiObsFlow = useStore( state => state.savedOrUploadedMultiObsFlow );
  const setObservations = useStore( state => state.setObservations );

  const isMultiObsFlow = observations.length > 1 || savedOrUploadedMultiObsFlow;

  const startedRef = useRef( false );
  const offlineConfidenceRef = useRef( new Map<string, number>( ) );
  const onlineStartedRef = useRef( new Set<string>( ) );
  const onlineCompleteRef = useRef( new Set<string>( ) );

  useEffect( ( ) => {
    if ( !isMultiObsFlow || startedRef.current ) {
      return ( ) => { };
    }
    startedRef.current = true;
    let cancelled = false;

    const offlineConfidence = offlineConfidenceRef.current;
    const onlineStarted = onlineStartedRef.current;
    const onlineComplete = onlineCompleteRef.current;

    // Reorder the observations the user hasn't reached yet. The current
    // observation is only moved before the user has picked a taxon for it
    // (moveCurrent), so we never yank away one they're actively identifying.
    const applyReorder = ( moveCurrent: boolean ) => {
      const state = useStore.getState( );
      const obs = state.observations;
      const idx = state.currentObservationIndex;
      const currentHasTaxon = !!obs[idx]?.taxon;
      const regionStart = moveCurrent && !currentHasTaxon ? idx : idx + 1;
      if ( obs.length - regionStart <= 1 ) {
        return;
      }
      const head = obs.slice( 0, regionStart );
      const region = obs.slice( regionStart );
      const sorted = [...region].sort( ( a, b ) => {
        const aOnline = onlineComplete.has( a?.uuid ) ? 1 : 0;
        const bOnline = onlineComplete.has( b?.uuid ) ? 1 : 0;
        if ( aOnline !== bOnline ) {
          return bOnline - aOnline;
        }
        const aConf = offlineConfidence.get( a?.uuid ) ?? -1;
        const bConf = offlineConfidence.get( b?.uuid ) ?? -1;
        return bConf - aConf;
      } );
      const changed = sorted.some( ( o, i ) => o?.uuid !== region[i]?.uuid );
      if ( !changed ) {
        return;
      }
      setObservations( [...head, ...sorted] );
    };

    const run = async ( ) => {
      // PHASE 1: offline model for every queued observation.
      const queue = useStore.getState( ).observations;
      // eslint-disable-next-line no-restricted-syntax
      for ( const obs of queue ) {
        if ( cancelled ) { return; }
        if ( !obs?.uuid || offlineConfidence.has( obs.uuid ) ) {
          // eslint-disable-next-line no-continue
          continue;
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          const confidence = await scoreObservationOffline( realm, obs );
          offlineConfidence.set( obs.uuid, confidence );
        } catch ( error ) {
          offlineConfidence.set( obs.uuid, -1 );
          logger.error( "Failed to score observation offline", error );
        }
        // Surface the most confident offline ID first as scores come in.
        applyReorder( false );
      }
      if ( cancelled ) { return; }
      // With every offline confidence known, position the first observation too.
      applyReorder( true );

      // PHASE 2: online requests, least confident offline first.
      const onlineOrder = Array.from( offlineConfidence.entries( ) )
        .sort( ( a, b ) => a[1] - b[1] )
        .map( ( [uuid] ) => uuid );
      // eslint-disable-next-line no-restricted-syntax
      for ( const uuid of onlineOrder ) {
        if ( cancelled ) { return; }
        if ( onlineStarted.has( uuid ) ) {
          // eslint-disable-next-line no-continue
          continue;
        }
        const obs = useStore.getState( ).observations.find(
          ( candidate: RealmObservationPojo ) => candidate?.uuid === uuid,
        );
        if ( !obs ) {
          // Already identified and removed from the queue.
          // eslint-disable-next-line no-continue
          continue;
        }
        onlineStarted.add( uuid );
        try {
          // eslint-disable-next-line no-await-in-loop
          await prefetchObservationSuggestions( queryClient, obs );
        } catch ( error ) {
          logger.error( "Failed to preload online suggestions", error );
        }
        onlineComplete.add( uuid );
        // An observation with a finished online ID jumps to the front.
        applyReorder( false );
      }
    };

    run( );

    return ( ) => {
      cancelled = true;
    };
  }, [isMultiObsFlow, queryClient, realm, setObservations] );
};

export default usePreloadNextObservationSuggestions;
