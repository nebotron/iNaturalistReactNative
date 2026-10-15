import type { ApiIdentification } from "api/types";

export interface IdentificationOutcome {
  agreed: boolean;
  disagreed: boolean;
}

const createdAtTime = ( identification?: { created_at?: string } ): number => (
  identification?.created_at
    ? new Date( identification.created_at ).getTime( )
    : NaN
);

// Work out how other identifiers responded to one of the user's
// identifications. Anything added later by someone else that names the same
// taxon, or something more specific, counts as agreement. An explicit
// disagreement, or an identification on a different branch of the tree,
// counts as disagreement. A coarser identification without the disagreement
// flag is neither: it doesn't rule the user's taxon out.
const identificationOutcome = (
  mine: ApiIdentification,
  observationIdentifications: ApiIdentification[] = [],
): IdentificationOutcome => {
  const myTaxonId = mine.taxon?.id;
  const myTime = createdAtTime( mine );
  const outcome = { agreed: false, disagreed: false };
  if ( !myTaxonId || Number.isNaN( myTime ) ) return outcome;
  const myAncestorIds = mine.taxon?.ancestor_ids ?? [];

  observationIdentifications.forEach( identification => {
    if ( identification.id === mine.id ) return;
    if ( identification.current === false || identification.hidden ) return;
    if ( identification.user?.id === mine.user?.id ) return;
    const theirTime = createdAtTime( identification );
    if ( Number.isNaN( theirTime ) || theirTime <= myTime ) return;

    const theirTaxonId = identification.taxon?.id;
    if ( !theirTaxonId ) return;
    if ( identification.disagreement ) {
      outcome.disagreed = true;
      return;
    }
    const theirAncestorIds = identification.taxon?.ancestor_ids ?? [];
    if ( theirTaxonId === myTaxonId || theirAncestorIds.includes( myTaxonId ) ) {
      outcome.agreed = true;
      return;
    }
    if ( myAncestorIds.includes( theirTaxonId ) ) return;
    outcome.disagreed = true;
  } );

  return outcome;
};

export default identificationOutcome;
