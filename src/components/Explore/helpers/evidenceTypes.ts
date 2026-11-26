import { EVIDENCE_TYPE } from "providers/ExploreContext";

// Controlled term values: Evidence of Presence (22) and Alive or Dead (17)
const EVIDENCE_TERM_VALUE_IDS: Record<Exclude<EVIDENCE_TYPE, EVIDENCE_TYPE.UNKNOWN>, number> = {
  [EVIDENCE_TYPE.LIVE_ORGANISM]: 18,
  [EVIDENCE_TYPE.DEAD_ORGANISM]: 19,
  [EVIDENCE_TYPE.FEATHER]: 23,
  [EVIDENCE_TYPE.SCAT]: 25,
  [EVIDENCE_TYPE.TRACK]: 26,
  [EVIDENCE_TYPE.BONE]: 27,
  [EVIDENCE_TYPE.MOLT]: 28,
  [EVIDENCE_TYPE.GALL]: 29,
  [EVIDENCE_TYPE.EGG]: 30,
  [EVIDENCE_TYPE.HAIR]: 31,
  [EVIDENCE_TYPE.LEAFMINE]: 32,
  [EVIDENCE_TYPE.CONSTRUCTION]: 35,
};

const ORGANISM_TERM_VALUE_ID = 24;

export interface EvidenceTypeApiParams {
  without_term_id?: number;
  term_id?: number[];
  term_value_id?: number[];
  term_id_or_unknown?: number[];
  without_term_value_id?: number[];
}

// The API matches any annotation whose term is in term_id and value is in
// term_value_id, so selected types are ORed together.
const annotatedParams = ( types: EVIDENCE_TYPE[] ): EvidenceTypeApiParams => {
  const termValueIds = types.map(
    type => EVIDENCE_TERM_VALUE_IDS[type as Exclude<EVIDENCE_TYPE, EVIDENCE_TYPE.UNKNOWN>],
  );
  // Live and dead together means any organism, including ones only
  // annotated with the Organism evidence value
  if ( types.includes( EVIDENCE_TYPE.LIVE_ORGANISM )
    && types.includes( EVIDENCE_TYPE.DEAD_ORGANISM ) ) {
    termValueIds.push( ORGANISM_TERM_VALUE_ID );
  }
  return { term_id: [22, 17], term_value_id: termValueIds };
};

// Not annotated ORed with other types can't be a positive match, so exclude
// observations annotated with any value that wasn't selected instead
const notAnnotatedOrParams = ( types: EVIDENCE_TYPE[] ): EvidenceTypeApiParams => {
  const live = types.includes( EVIDENCE_TYPE.LIVE_ORGANISM );
  const dead = types.includes( EVIDENCE_TYPE.DEAD_ORGANISM );
  type AnnotatedType = keyof typeof EVIDENCE_TERM_VALUE_IDS;
  const excluded = ( Object.keys( EVIDENCE_TERM_VALUE_IDS ) as AnnotatedType[] )
    .filter( type => !types.includes( type ) )
    // Alive or Dead values only narrow down an organism the user asked for
    .filter( type => ( type === EVIDENCE_TYPE.LIVE_ORGANISM && dead )
      || ( type === EVIDENCE_TYPE.DEAD_ORGANISM && live )
      || ( type !== EVIDENCE_TYPE.LIVE_ORGANISM && type !== EVIDENCE_TYPE.DEAD_ORGANISM ) )
    .map( type => EVIDENCE_TERM_VALUE_IDS[type] );
  if ( !live && !dead ) { excluded.push( ORGANISM_TERM_VALUE_ID ); }
  return { term_id_or_unknown: [22, 17], without_term_value_id: excluded };
};

export const evidenceTypesToApiParams = (
  evidenceTypes: EVIDENCE_TYPE[] | null | undefined,
): EvidenceTypeApiParams => {
  if ( !evidenceTypes || evidenceTypes.length === 0 ) { return {}; }
  const annotatedTypes = evidenceTypes.filter( type => type !== EVIDENCE_TYPE.UNKNOWN );
  if ( annotatedTypes.length === evidenceTypes.length ) { return annotatedParams( evidenceTypes ); }
  if ( annotatedTypes.length === 0 ) { return { without_term_id: 22 }; }
  return notAnnotatedOrParams( annotatedTypes );
};
