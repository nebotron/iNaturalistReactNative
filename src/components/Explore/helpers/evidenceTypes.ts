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

export interface EvidenceTypeApiParams {
  without_term_id?: number;
  term_id?: number[];
  term_value_id?: number[];
}

// The API matches any annotation whose term is in term_id and value is in
// term_value_id, so selected types are ORed together.
export const evidenceTypesToApiParams = (
  evidenceTypes: EVIDENCE_TYPE[] | null | undefined,
): EvidenceTypeApiParams => {
  if ( !evidenceTypes || evidenceTypes.length === 0 ) { return {}; }
  if ( evidenceTypes.includes( EVIDENCE_TYPE.UNKNOWN ) ) { return { without_term_id: 22 }; }
  const termValueIds = evidenceTypes.map(
    type => EVIDENCE_TERM_VALUE_IDS[type as Exclude<EVIDENCE_TYPE, EVIDENCE_TYPE.UNKNOWN>],
  );
  // Live and dead together means any organism, including ones only
  // annotated with the Organism evidence value
  if ( evidenceTypes.includes( EVIDENCE_TYPE.LIVE_ORGANISM )
    && evidenceTypes.includes( EVIDENCE_TYPE.DEAD_ORGANISM ) ) {
    termValueIds.push( 24 );
  }
  return { term_id: [22, 17], term_value_id: termValueIds };
};

// Unknown is exclusive of the other evidence types. Mirrors ExploreContext's
// TOGGLE_EVIDENCE_TYPE, which can't import this without a circular import.
export const toggleEvidenceType = (
  current: EVIDENCE_TYPE[] | null | undefined,
  evidenceType: EVIDENCE_TYPE,
): EVIDENCE_TYPE[] => {
  const types = current || [];
  if ( types.includes( evidenceType ) ) {
    return types.filter( type => type !== evidenceType );
  }
  if ( evidenceType === EVIDENCE_TYPE.UNKNOWN ) { return [EVIDENCE_TYPE.UNKNOWN]; }
  return [...types.filter( type => type !== EVIDENCE_TYPE.UNKNOWN ), evidenceType];
};
