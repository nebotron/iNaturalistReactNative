import { RealmContext } from "providers/contexts";
import { useMemo } from "react";
import Observation from "realmModels/Observation";

import type { AudioIdClip } from "./audioIdHistory";

const { useQuery } = RealmContext;

// Observations of the same species within this long of the clip are offered to add it to.
export const NEARBY_MS = 60 * 1000;
export const obsTime = ( obs: Observation ) => Date
  .parse( obs.time_observed_at || obs.observed_on_string );

// The user's label wins over the model's ID; "no organism" matches nothing.
export const clipTaxonId = ( clip: AudioIdClip ) => clip.label?.taxonId
  || ( clip.label?.taxonId === null
    ? null
    : clip.sp.taxonId );

// IDs of the clips not yet added to an observation that could be added to a
// saved observation of the same species.
const useEligibleClips = ( clips: AudioIdClip[] ) => {
  const taxonIds = [...new Set( clips.map( clipTaxonId ).filter( Boolean ) )];
  const observations = useQuery( {
    type: Observation,
    query: obs => obs.filtered( "taxon.id IN $0", taxonIds ),
  }, [taxonIds.join( )] );
  return useMemo( ( ) => {
    const timesByTaxon = new Map<number, number[]>( );
    observations.forEach( obs => {
      const id = obs.taxon?.id;
      if ( !id ) return;
      timesByTaxon.set( id, [...( timesByTaxon.get( id ) || [] ), obsTime( obs )] );
    } );
    return new Set( clips
      .filter( clip => !clip.observationUuid
        && ( timesByTaxon.get( clipTaxonId( clip ) || 0 ) || [] )
          .some( t => Math.abs( t - clip.time ) <= NEARBY_MS ) )
      .map( clip => clip.id ) );
  }, [clips, observations] );
};

export default useEligibleClips;
