import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { log } from "sharedHelpers/logger";
import prefetchObservationSuggestions from "sharedHelpers/prefetchObservationSuggestions";
import useStore from "stores/useStore";

const logger = log.extend( "usePreloadNextObservationSuggestions" );

const usePreloadNextObservationSuggestions = ( ) => {
  const queryClient = useQueryClient( );
  const observations = useStore( state => state.observations );
  const currentObservationIndex = useStore( state => state.currentObservationIndex );
  const savedOrUploadedMultiObsFlow = useStore( state => state.savedOrUploadedMultiObsFlow );

  const isMultiObsCreateFlow = observations.length > 1 || savedOrUploadedMultiObsFlow;
  const nextObservation = isMultiObsCreateFlow
    ? observations[currentObservationIndex + 1]
    : undefined;

  useEffect( ( ) => {
    if ( !nextObservation ) {
      return;
    }

    prefetchObservationSuggestions( queryClient, nextObservation ).catch( error => {
      logger.error( "Failed to preload next observation suggestions", error );
    } );
  }, [nextObservation, queryClient] );
};

export default usePreloadNextObservationSuggestions;
