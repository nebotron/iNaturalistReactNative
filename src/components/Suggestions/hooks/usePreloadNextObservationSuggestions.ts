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
  const nextObs1 = isMultiObsCreateFlow ? observations[currentObservationIndex + 1] : undefined;
  const nextObs2 = isMultiObsCreateFlow ? observations[currentObservationIndex + 2] : undefined;
  const nextObs3 = isMultiObsCreateFlow ? observations[currentObservationIndex + 3] : undefined;

  useEffect( ( ) => {
    [nextObs1, nextObs2, nextObs3].forEach( obs => {
      if ( !obs ) {
        return;
      }
      prefetchObservationSuggestions( queryClient, obs ).catch( error => {
        logger.error( "Failed to preload next observation suggestions", error );
      } );
    } );
  }, [nextObs1, nextObs2, nextObs3, queryClient] );
};

export default usePreloadNextObservationSuggestions;
