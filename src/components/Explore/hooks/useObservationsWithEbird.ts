import { isEbirdObservation } from "api/ebird";
import type { ApiObservation } from "api/types";
import useEbirdObservations from "components/Explore/hooks/useEbirdObservations";
import { useMemo } from "react";
import useStore from "stores/useStore";

interface Options {
  enabled: boolean;
  // Whether every iNaturalist page has loaded
  complete: boolean;
}

// eBird has no upload date, so sightings sort by observation date throughout
const sortValue = ( obs: ApiObservation, orderBy: unknown ) => (
  orderBy === "created_at" && !isEbirdObservation( obs )
    ? obs.created_at
    : obs.time_observed_at || obs.observed_on
) || "";

// Only eBird sightings when that's the chosen source. Otherwise
// iNaturalist results with matching eBird sightings merged in where the
// search's sort order puts them, so every view handles both alike. A sighting
// that sorts after the last loaded page waits for that page.
const useObservationsWithEbird = (
  observations: ApiObservation[],
  params: Record<string, unknown>,
  { enabled, complete }: Options,
) => {
  const ebirdOnly = useStore( state => state.layout.observationSource === "ebird" );
  const ebird = useEbirdObservations( params, enabled );
  const ebirdObservations = ebird?.observations;
  const { order_by: orderBy, order } = params;
  const merged = useMemo( ( ) => {
    const sign = order === "asc"
      ? 1
      : -1;
    const compare = ( a: ApiObservation, b: ApiObservation ) => sign
      * sortValue( a, orderBy ).localeCompare( sortValue( b, orderBy ) );
    if ( ebirdOnly ) return [...( ebirdObservations || [] )].sort( compare );
    if ( !ebirdObservations?.length ) return observations;
    // Sightings have no faves, so they come after every iNaturalist result
    if ( orderBy !== "observed_on" && orderBy !== "created_at" ) {
      return complete
        ? [...observations, ...ebirdObservations]
        : observations;
    }
    const last = observations[observations.length - 1];
    const sightings = ebirdObservations
      .filter( obs => complete || ( last && compare( obs, last ) <= 0 ) )
      .sort( compare );
    const result: ApiObservation[] = [];
    let i = 0;
    observations.forEach( obs => {
      while ( i < sightings.length && compare( sightings[i], obs ) < 0 ) {
        result.push( sightings[i] );
        i += 1;
      }
      result.push( obs );
    } );
    return [...result, ...sightings.slice( i )];
  }, [complete, ebirdOnly, ebirdObservations, observations, order, orderBy] );
  return { ebird, observations: merged };
};

export default useObservationsWithEbird;
