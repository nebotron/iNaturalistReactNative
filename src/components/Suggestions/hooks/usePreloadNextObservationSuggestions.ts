import { useQueryClient } from "@tanstack/react-query";
import orderBy from "lodash/orderBy";
import { RealmContext } from "providers/contexts";
import { useEffect, useRef } from "react";
import Taxon from "realmModels/Taxon";
import { log } from "sharedHelpers/logger";
import prefetchObservationSuggestions, {
  prefetchOfflineSuggestions,
} from "sharedHelpers/prefetchObservationSuggestions";
import type { OfflineSuggestionsResponse } from "sharedHooks/useSuggestions/useOfflineSuggestions";
import useStore from "stores/useStore";

const { useRealm } = RealmContext;

const logger = log.extend( "usePreloadNextObservationSuggestions" );

// Confidence, as a percentage, in the most likely species. The on-device model
// returns a taxonomic branch in which the coarser ancestors always score higher
// than the species, so everything broader than species is ignored; an
// observation the model can only place in a coarse taxon scores 0.
const topSpeciesScore = ( suggestions: OfflineSuggestionsResponse | null ): number => {
  const results = suggestions?.results || [];
  return results.reduce( ( highest, suggestion ) => {
    const rankLevel = suggestion.taxon?.rank_level;
    return rankLevel != null && rankLevel <= Taxon.SPECIES_LEVEL
      ? Math.max( highest, suggestion.combined_score || 0 )
      : highest;
  }, 0 );
};

const usePreloadNextObservationSuggestions = ( ) => {
  const queryClient = useQueryClient( );
  const realm = useRealm( );
  const observations = useStore( state => state.observations );
  const currentObservationIndex = useStore( state => state.currentObservationIndex );
  const savedOrUploadedMultiObsFlow = useStore( state => state.savedOrUploadedMultiObsFlow );
  const bulkUploadMode = useStore( state => state.bulkUploadMode );
  const setObservations = useStore( state => state.setObservations );
  const sortStartedRef = useRef( false );

  const isMultiObsCreateFlow = observations.length > 1 || savedOrUploadedMultiObsFlow;
  const nextObs1 = isMultiObsCreateFlow
    ? observations[currentObservationIndex + 1]
    : undefined;
  const nextObs2 = isMultiObsCreateFlow
    ? observations[currentObservationIndex + 2]
    : undefined;
  const nextObs3 = isMultiObsCreateFlow
    ? observations[currentObservationIndex + 3]
    : undefined;

  // One at a time: each prefetch resizes a photo and uploads it for scoring,
  // and three of those at once starve the request for the observation the user
  // is looking at right now.
  useEffect( ( ) => {
    let cancelled = false;

    const preload = async ( ) => {
      for ( const obs of [nextObs1, nextObs2, nextObs3] ) {
        if ( cancelled ) { return; }
        if ( obs ) {
          // eslint-disable-next-line no-await-in-loop
          await prefetchObservationSuggestions( queryClient, obs, realm ).catch( error => {
            logger.error( "Failed to preload next observation suggestions", error );
          } );
        }
      }
    };

    preload( );

    return ( ) => {
      cancelled = true;
    };
  }, [nextObs1, nextObs2, nextObs3, queryClient, realm] );

  // The bulk ID flow arrives ordered by when the observations were created,
  // which says nothing about how easy they are to identify. Score them all with
  // the on-device model in the background, then put the ones the model is most
  // confident about first so the easiest IDs come first. Observations are
  // scored one at a time and the reorder only touches the ones the user hasn't
  // reached yet, so nothing shifts under them while they work.
  useEffect( ( ) => {
    if ( !bulkUploadMode || sortStartedRef.current || observations.length < 2 ) {
      return ( ) => undefined;
    }
    sortStartedRef.current = true;
    let cancelled = false;

    const sortByConfidence = async ( ) => {
      const scoresByUuid: Record<string, number> = {};
      for ( const observation of observations ) {
        // eslint-disable-next-line no-await-in-loop
        const suggestions = await prefetchOfflineSuggestions( observation, realm );
        if ( cancelled ) { return; }
        scoresByUuid[observation.uuid] = topSpeciesScore( suggestions );
      }

      // Identified observations leave the flow as the user goes, so sort the
      // list as it stands now, leaving the observation on screen where it is.
      const { observations: current, currentObservationIndex: index } = useStore.getState( );
      setObservations( [
        ...current.slice( 0, index + 1 ),
        ...orderBy(
          current.slice( index + 1 ),
          observation => scoresByUuid[observation.uuid] ?? 0,
          "desc",
        ),
      ] );
    };

    sortByConfidence( ).catch( error => {
      logger.error( "Failed to sort bulk ID observations by confidence", error );
    } );

    return ( ) => {
      cancelled = true;
    };
  }, [bulkUploadMode, observations, realm, setObservations] );
};

export default usePreloadNextObservationSuggestions;
